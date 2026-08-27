const puppeteer = require('puppeteer');
const {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb,
} = require('./utils/cronTime');
const { updatePriceChangeData } = require('./utils/priceChange');
const { getStorePincode } = require('./utils/pinCode');
const {
    executeMongoFind,
    executeMongoUpdate,
} = require('./mongo');

const cronName = 'croma';

// ============================================================
// HELPERS: MONGODB OPERATIONS WITH TRY-CATCH
// ============================================================

async function findDocuments(collectionName, cmpid, filter, projection = {}) {
    try {
        const docs = await executeMongoFind(
            { collection: collectionName, cmpid },
            filter,
            projection
        );
        return docs || [];
    } catch (error) {
        console.error(`MongoDB find error in ${collectionName}:`, error.message);
        return [];
    }
}

async function updateDocument(collectionName, cmpid, filter, updateData) {
    try {
        await executeMongoUpdate(
            { collection: collectionName, cmpid },
            filter,
            updateData
        );
        return true;
    } catch (error) {
        console.error(`MongoDB update error in ${collectionName}:`, error.message);
        return false;
    }
}

// ============================================================
// HELPER: SET PINCODE WITH SSE EVENTS
// ============================================================

async function ensurePincodeSet(page, pincode, reporter, context) {
    // context: { productId, productCode, productNumber }
    try {
        reporter('pincode_detected', {
            ...context,
            status: 'running',
            message: 'Pincode popup detected, setting pincode...',
        });

        await page.waitForSelector('.pinElem', { visible: true, timeout: 10000 });
        const input = await page.$('.pinElem');

        // Clear existing value
        await input.click({ clickCount: 3 });
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');

        const code = pincode || '110001';

        reporter('pincode_setting', {
            ...context,
            status: 'running',
            message: `Entering pincode: ${code}`,
        });

        await input.type(code, { delay: 500 });

        // Trigger events
        await input.evaluate(el => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        });

        await page.click('#apply-pincode-btn');

        // Wait until the dialog disappears
        await page.waitForFunction(() => {
            const dialog = document.querySelector('.MuiDialog-root');
            return !dialog || getComputedStyle(dialog).display === 'none';
        }, { timeout: 30000 });

        await page.waitForNetworkIdle({ idleTime: 2000, timeout: 10000 });

        reporter('pincode_success', {
            ...context,
            status: 'completed',
            message: `Pincode set successfully to ${code}`,
        });
        console.log('Pincode set successfully.');
    } catch (err) {
        const errorMsg = err.message || 'Unknown error';
        reporter('pincode_failed', {
            ...context,
            status: 'failed',
            message: `Failed to set pincode: ${errorMsg}`,
        });
        console.warn('Failed to set pincode:', errorMsg);
    }
}

// ============================================================
// HELPER: SCRAPE A SINGLE PRODUCT
// ============================================================

async function scrapeSingleProduct(
    browser,
    product,
    companyId,
    pincode,
    currentProductNumber,
    totalProducts,
    sendEvent
) {
    const productUrl = product.product_url;
    const productId = product[`${companyId}_product_id`];
    const productCode = product[`${companyId}_product_code`];
    const context = { productId, productCode, productNumber: currentProductNumber };

    // Validate URL
    let hostname;
    try {
        hostname = new URL(productUrl).hostname;
    } catch {
        throw new Error('Invalid product URL');
    }
    if (!hostname.includes('croma')) {
        throw new Error('Only Croma URLs supported');
    }

    // Create a fresh page for this product
    const productPage = await browser.newPage();
    await productPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
    );

    let result = {
        price: 'No Result',
        stock: 'No Result',
        image: 'No Result',
        review: 'No Result',
        rating: 'No Result',
        scrapeStatus: 'pending',
    };

    try {
        // Navigate to product page
        await productPage.goto(productUrl, {
            waitUntil: 'networkidle2',
            timeout: 50000,
        });

        // Check for pincode popup (fast, non‑blocking)
        const popupInput = await productPage.$('.MuiDialog-root .pinElem');
        if (popupInput) {
            await ensurePincodeSet(productPage, pincode, sendEvent, context);
        }

        // Check if product title exists
        const titleExists = await productPage.$('.pd-title-normal');
        if (!titleExists) {
            // Product not found – keep defaults
            return result;
        }

        // Wait for required selectors and extract data
        await productPage.waitForSelector(
            'script[type="application/ld+json"], [class*="pd-title-normal"], .pd-title-normal',
            { timeout: 30000 }
        );

        const scraped = await productPage.evaluate(() => {
            // Extract JSON-LD product data
            const productData = [...document.querySelectorAll('script[type="application/ld+json"]')]
                .map(script => {
                    let text = script.textContent.trim();
                    try {
                        return JSON.parse(text);
                    } catch {
                        try {
                            // Fix invalid escape sequences
                            text = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
                            text = text.replace(
                                /"description"\s*:\s*"([\s\S]*?)",\s*"brand"/,
                                (_, desc) => {
                                    const fixedDesc = desc
                                        .replace(/\r/g, "")
                                        .replace(/\n/g, "\\n")
                                        .replace(/"/g, '\\"');
                                    return `"description":"${fixedDesc}","brand"`;
                                }
                            );
                            while (true) {
                                try {
                                    return JSON.parse(text);
                                } catch {
                                    if (text.endsWith("}")) {
                                        text = text.slice(0, -1).trim();
                                    } else {
                                        break;
                                    }
                                }
                            }
                        } catch {
                            return null;
                        }
                    }
                })
                .find(item => item?.["@type"] === "Product");

            const priceElement = document.querySelector('#pdp-product-price');
            const price = priceElement?.textContent?.trim() || '';
            const stockIndicator = document.querySelector('span.not-available-color') ||
                                   document.querySelector('span.approvalStatus-span-message');
            const availability = stockIndicator ? 'outofstock' : 'instock';

            return {
                price,
                image: productData?.image?.[0] || '',
                availability,
                review: productData?.aggregateRating?.ratingCount || '0',
                rating: productData?.aggregateRating?.ratingValue || '0',
            };
        });

        // Process scraped data
        if (scraped !== null) {
            const availability = (scraped.availability || '').toLowerCase().trim();
            const cleanedPrice = (scraped.price || '').replace(/[^0-9.]/g, '');

            result.review = parseFloat(scraped.review) || 0;
            result.rating = (Math.round(parseFloat(scraped.rating) * 10) / 10) || 0;
            result.image = scraped.image || 'No Result';

            if (availability === 'instock' && cleanedPrice > 0) {
                result.price = parseFloat(cleanedPrice) || 'No Result';
                result.stock = 'In stock';
                result.scrapeStatus = 'completed';
            } else if (availability.includes('outofstock') || availability.includes('currently unavailable')) {
                result.stock = 'Out Of Stock';
                result.scrapeStatus = 'completed';
            } else {
                result.scrapeStatus = 'pending';
            }
        }

        return result;
    } catch (error) {
        console.error(`Error scraping product ${productId}:`, error.message);
        throw error;
    } finally {
        await productPage.close();
        console.log(`Product page for ${productId} closed.`);
    }
}

// ============================================================
// MAIN SCRAPER FUNCTION
// ============================================================

async function cromaScraper(req, res) {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let browser;

    // SSE helper
    const sendEvent = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    };

    // --------------------------------------------
    // 1. Request validation
    // --------------------------------------------
    const cmpid = req.query.cmpid;
    if (!cmpid) {
        return res.status(400).json({ status: false, message: 'cmpid is required' });
    }
    const companyId = cmpid.replace('plm_user_info_', '');
    const ean = req.query.ean;
    const itemcode = req.query.itemcode;
    const isSingleProduct = !!(ean && itemcode);

    // --------------------------------------------
    // 2. Set up SSE headers
    // --------------------------------------------
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Client disconnect handling
    let clientDisconnected = false;
    req.on('close', () => {
        clientDisconnected = true;
        console.log('Croma client disconnected');
    });

    // Initial event
    sendEvent('start', {
        status: true,
        message: 'Croma scraping started',
        cmpid,
        companyId,
        isSingleProduct,
    });

    try {
        // --------------------------------------------
        // 3. Launch browser
        // --------------------------------------------
        sendEvent('step', {
            step: 'browser',
            status: 'running',
            message: 'Launching browser...',
        });

        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-features=Translate,BackForwardCache',
            ],
            timeout: 30000,
        });

        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://www.croma.com', []);

        // --------------------------------------------
        // 4. Fetch products from DB
        // --------------------------------------------
        sendEvent('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching Croma products...',
        });

        const filter = {
            status: 'active',
            product_scrape_status: { $in: ['pending', 'completed'] },
            product_url: { $nin: ['', null, 'No Result'] },
        };
        if (isSingleProduct) {
            filter[`${companyId}_product_id`] = ean;
            filter[`${companyId}_product_code`] = itemcode;
        }

        const products = await findDocuments(
            'ept_product_details_new_croma',
            cmpid,
            filter,
            { _id: 0 }
        );

        if (!products || products.length === 0) {
            sendEvent('complete', {
                status: true,
                message: 'Competitor products not found',
                totalProcessed: 0,
                data: [],
            });
            res.end();
            return;
        }

        // --------------------------------------------
        // 5. Filter products that exist in our master list
        // --------------------------------------------
        const existingProducts = await findDocuments(
            'ept_product_details_new',
            cmpid,
            {
                $and: [
                    { status: 'active' },
                    { ean_product_data_details_scrap_status: 'completed' },
                ],
            },
            { _id: 0, product_ean_id: 1, product_code: 1 }
        );

        const productMap = new Set();
        existingProducts.forEach(row => {
            productMap.add(`${row.product_ean_id}_${row.product_code}`);
        });

        const productsToScrape = [];
        products.forEach(row => {
            const key = `${row[`${companyId}_product_id`]}_${row[`${companyId}_product_code`]}`;
            if (productMap.has(key) && row.product_url.includes('https://www.croma.com/')) {
                productsToScrape.push(row);
            }
        });

        if (productsToScrape.length === 0) {
            sendEvent('complete', {
                status: true,
                message: 'Active products not found',
                totalProcessed: 0,
                data: [],
            });
            res.end();
            return;
        }

        const totalProducts = productsToScrape.length;
        const startTime = new Date(
            `${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`
        );
        const cronStartTime = getCurrentIndTimeInfo();

        // Update start time in DB (only for full cron runs)
        if (!isSingleProduct) {
            await updateStartTimeInDb(cmpid, companyId, cronName, totalProducts);
        }

        sendEvent('progress', {
            status: 'running',
            totalProducts,
            processedProducts: 0,
            progress: 0,
            message: `${totalProducts} products found`,
        });

        // Get pincode from DB or fallback
        let pincode = await getStorePincode(companyId);
        if (pincode === null) {
            pincode = req.query.pincode || '600018';
        }

        const scrapedData = [];
        let productCount = 0;

        // --------------------------------------------
        // 6. Loop over each product
        // --------------------------------------------
        for (const product of productsToScrape) {
            if (clientDisconnected) {
                console.log('Client disconnected. Stopping stream.');
                break;
            }

            productCount++;
            const currentNumber = productCount;
            const progressBefore = Math.round(((currentNumber - 1) / totalProducts) * 100);

            const productId = product[`${companyId}_product_id`];
            const productCode = product[`${companyId}_product_code`];

            sendEvent('product_start', {
                productNumber: currentNumber,
                totalProducts,
                progress: progressBefore,
                productId,
                productCode,
                productUrl: product.product_url,
                status: 'running',
                message: `Scraping product ${currentNumber} of ${totalProducts}`,
            });

            let scrapeResult;
            try {
                scrapeResult = await scrapeSingleProduct(
                    browser,
                    product,
                    companyId,
                    pincode,
                    currentNumber,
                    totalProducts,
                    sendEvent  // pass the reporter
                );
            } catch (error) {
                // Product scraping failed – mark as pending in DB
                console.error(`Product ${productId} failed:`, error.message);
                await updateDocument(
                    'ept_product_details_new_croma',
                    cmpid,
                    {
                        [`${companyId}_product_id`]: productId,
                        [`${companyId}_product_code`]: productCode,
                    },
                    {
                        $set: {
                            product_scrape_status: 'pending',
                            modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time'),
                        },
                    }
                );
                sendEvent('product_error', {
                    productNumber: currentNumber,
                    totalProducts,
                    productId,
                    productCode,
                    progress: Math.round((currentNumber / totalProducts) * 100),
                    status: 'error',
                    message: error.message || 'Error scraping product',
                });
                continue;
            }

            // Update scraped data in DB
            const updateSuccess = await updateDocument(
                'ept_product_details_new_croma',
                cmpid,
                {
                    [`${companyId}_product_id`]: productId,
                    [`${companyId}_product_code`]: productCode,
                },
                {
                    $set: {
                        product_price: scrapeResult.price,
                        product_stock: scrapeResult.stock,
                        product_image: scrapeResult.image,
                        product_review: scrapeResult.review,
                        product_rating: scrapeResult.rating,
                        modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time'),
                        product_scrape_status: scrapeResult.scrapeStatus,
                    },
                }
            );

            // Track price changes
            updatePriceChangeData(
                scrapeResult.scrapeStatus,
                product.product_price,
                scrapeResult.price,
                productId,
                productCode,
                cronName,
                cmpid,
                companyId
            );

            const productResult = {
                product_ean_id: productId,
                product_code: productCode,
                product_price: scrapeResult.price,
                product_stock: scrapeResult.stock,
                modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time'),
                scrape_status: scrapeResult.scrapeStatus,
            };
            scrapedData.push(productResult);

            const progressAfter = Math.round((currentNumber / totalProducts) * 100);
            sendEvent('product_complete', {
                productNumber: currentNumber,
                totalProducts,
                processedProducts: currentNumber,
                progress: progressAfter,
                productId,
                productCode,
                status: scrapeResult.scrapeStatus === 'completed' ? 'success' : 'pending',
                data: productResult,
                message: `Product ${currentNumber} completed`,
            });

            // Update cron progress (for full runs)
            if (!isSingleProduct) {
                await updateEndTimeInDb(
                    currentNumber,
                    'running',
                    cmpid,
                    companyId,
                    null,
                    cronName,
                    cronStartTime,
                    totalProducts
                );
            }

            await delay(100);
        }

        // --------------------------------------------
        // 7. Final summary
        // --------------------------------------------
        const endTime = new Date(
            `${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`
        );
        const totalMinutes = +((endTime - startTime) / 60000).toFixed(2);

        if (!isSingleProduct) {
            await updateEndTimeInDb(
                productCount,
                'ending',
                cmpid,
                companyId,
                totalMinutes,
                cronName,
                cronStartTime,
                totalProducts
            );
        }

        sendEvent('complete', {
            status: true,
            message: 'Scraping completed',
            totalProducts,
            totalProcessed: productCount,
            progress: 100,
            totalMinutes,
            data: scrapedData,
        });

        res.end();
    } catch (error) {
        console.error('Croma scraper error:', error);
        if (!res.writableEnded) {
            sendEvent('error', {
                status: false,
                message: error.message || 'Croma scraping failed',
            });
            res.end();
        }
    } finally {
        if (browser) {
            console.log('Closing browser...');
            try {
                await browser.close();
            } catch (error) {
                console.error('Browser close error:', error);
            }
        }
    }
}

module.exports = { cromaScraper };