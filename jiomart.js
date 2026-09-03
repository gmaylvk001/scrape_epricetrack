const puppeteer = require('puppeteer');
const {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb
} = require('./utils/cronTime');

const { updatePriceChangeData } = require('./utils/priceChange');
const { getStorePincode } = require('./utils/pinCode');

const {
    executeMongoFind,
    executeMongoUpdate
} = require('./mongo');

const cronName = 'jiomart';

async function jiomartScraper(req, res) {

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let browser;

    // ── SSE sender ───────────────────────────────────────────────
    const sendEvent = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    };

    // ── Request validation ──────────────────────────────────────
    const cmpid = req.query.cmpid;
    if (!cmpid) {
        return res.status(400).json({
            status: false,
            message: 'cmpid is required'
        });
    }
    const companyId = cmpid.replace('plm_user_info_', '');
    const ean = req.query.ean;
    const itemcode = req.query.itemcode;
    const isSingleProduct = !!(ean && itemcode);

    // ── SSE headers ──────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // ── Client disconnect ──────────────────────────────────────
    let clientDisconnected = false;
    req.on('close', () => {
        clientDisconnected = true;
        console.log('Jiomart client disconnected');
    });

    // ── Start event ──────────────────────────────────────────────
    sendEvent('start', {
        status: true,
        message: 'Jiomart scraping started',
        cmpid,
        companyId,
        isSingleProduct
    });

    try {
        // ── Launch browser ──────────────────────────────────────
        sendEvent('step', {
            step: 'browser',
            status: 'running',
            message: 'Launching browser...'
        });

        browser = await puppeteer.launch({
            headless: false,
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
                '--disable-features=Translate,BackForwardCache'
            ],
            timeout: 30000
        });

        // ── Fetch products ──────────────────────────────────────
        sendEvent('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching Jiomart products...'
        });

        const filter = {
            status: 'active',
            product_scrape_status: { $in: ['pending', 'completed'] },
            product_url: { $nin: ['', null, 'No Result'] }
        };
        if (isSingleProduct) {
            filter[`${companyId}_product_id`] = ean;
            filter[`${companyId}_product_code`] = itemcode;
        }

        const products = await executeMongoFind(
            { collection: 'ept_product_details_new_jiomart', cmpid },
            filter,
            { _id: 0 }
        );

        if (!products || products.length === 0) {
            sendEvent('complete', {
                status: true,
                message: 'Competitor products not found',
                totalProcessed: 0,
                data: []
            });
            res.end();
            return;
        }

        // ── Match with active products ──────────────────────────
        const existingProducts = await executeMongoFind(
            { collection: 'ept_product_details_new', cmpid },
            { status: 'active' },
            { _id: 0, product_ean_id: 1, product_code: 1 }
        );
        const productMap = new Set(
            existingProducts.map(r => `${r.product_ean_id}_${r.product_code}`)
        );

        const productsToScrape = products.filter(p =>
            productMap.has(`${p[`${companyId}_product_id`]}_${p[`${companyId}_product_code`]}`)
        );

        if (productsToScrape.length === 0) {
            sendEvent('complete', {
                status: true,
                message: 'Active products not found',
                totalProcessed: 0,
                data: []
            });
            res.end();
            return;
        }

        // ── Init ──────────────────────────────────────────────────
        let productCount = 0;
        const total = productsToScrape.length;
        const startTime = new Date(
            `${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`
        );
        const cronStartTime = getCurrentIndTimeInfo();

        if (!isSingleProduct) {
            await updateStartTimeInDb(cmpid, companyId, cronName, total);
        }

        sendEvent('progress', {
            status: 'running',
            totalProducts: total,
            processedProducts: 0,
            progress: 0,
            message: `${total} products found`
        });

        
       /*
        ========================================================
        SET PINCODE (using mainPage)
        ========================================================
        */

        let pincode = await getStorePincode(companyId);
        if (pincode === null) {
            pincode = req.query.pincode;
        }
        
        sendEvent('step', {
            step: 'pincode',
            status: 'running',
            message: `Setting pincode for Jiomart... pincode: ${pincode}`
        });

        try {
            // Create a new page for pincode setup
            const mainPage = await browser.newPage();
            
            // Set user agent and headers
            await mainPage.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
            );
            
            await mainPage.setExtraHTTPHeaders({
                'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
                'Sec-Ch-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'Sec-Ch-UA-Mobile': '?0',
                'Sec-Ch-UA-Platform': '"Windows"',
            });
            
            await mainPage.setViewport({ width: 1366, height: 768 });

            // Navigate to Jiomart homepage
            const productUrltest = "https://www.jiomart.com/";
            
            await mainPage.goto(productUrltest, {
                waitUntil: 'networkidle2',
                timeout: 50000
            });

            await delay(3000);

            // Check if pincode popup exists
            const pincodePopupExists = await mainPage.$('button.AllowLocation__buttons.AllowLocation__buttonsborder');
        
            if (pincodePopupExists === null) {
                console.log('Jiomart pincode popup not found, continuing...');
                sendEvent('step', {
                    step: 'pincode',
                    status: 'skipped',
                    message: 'Pincode popup not found, continuing...'
                });
            } else {

                // Wait for pincode button to be visible
                await mainPage.waitForSelector('button.AllowLocation__buttons.AllowLocation__buttonsborder', {
                    visible: true,
                    timeout: 15000
                });

                // Click the pincode button to open the popup
                await mainPage.click('button.AllowLocation__buttons.AllowLocation__buttonsborder');
                await delay(2000);

    
                // Wait for the pincode input field in the popup
                await mainPage.waitForSelector('input.AddressListModal__search-input.pac-target-input', {
                    visible: true,
                    timeout: 15000
                });

                // Clear the existing pincode (if any) and type the new one
                await mainPage.evaluate(() => {
                    const input = document.getElementById('input.AddressListModal__search-input.pac-target-input');
                    if (input) {
                        input.value = ''; // Clear the input field
                        input.focus();
                    }
                });
                
                await delay(500);
                
                // Wait for pincode input
                const pincodeInputSelector =
                    'input.AddressListModal__search-input.pac-target-input';

                await mainPage.waitForSelector(pincodeInputSelector, {
                    visible: true,
                    timeout: 15000
                });

                // Clear existing value correctly
                await mainPage.click(pincodeInputSelector);

                await mainPage.evaluate((selector) => {
                    const input = document.querySelector(selector);

                    if (input) {
                        input.value = '';
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, pincodeInputSelector);

                await delay(500);

                // Type pincode
                await mainPage.type(pincodeInputSelector, String(pincode), {
                    delay: 100
                });

                // Wait for Google/JioMart autocomplete suggestions
                const suggestionSelector = 'div.pac-container div.pac-item';

                await mainPage.waitForSelector(suggestionSelector, {
                    visible: true,
                    timeout: 15000
                });

                // Click first suggestion
                await mainPage.click(suggestionSelector);

                await delay(1500);

                // Confirm pincode
                const confirmButtonSelector =
                    'button.AddressFullscreenModal__confirm-button';

                await mainPage.waitForSelector(confirmButtonSelector, {
                    visible: true,
                    timeout: 15000
                });

                await mainPage.click(confirmButtonSelector);

                await delay(3000);

                sendEvent('step', {
                    step: 'pincode',
                    status: 'completed',
                    message: `Pincode set successfully: ${pincode}`
                });
                
            }

        } catch (err) {
            console.log("Unable to set pincode:", err.message);
            sendEvent('step', {
                step: 'pincode',
                status: 'failed',
                message: `Unable to set pincode: ${err.message}`
            });
        }

        const scrapedData = [];
        const failedProducts = []; // will store { product, productNumber }

        // ── Main loop ─────────────────────────────────────────────
        for (const product of productsToScrape) {

            if (clientDisconnected) break;

            productCount++;
            const currentProductNumber = productCount;

            sendEvent('product_start', {
                productNumber: currentProductNumber,
                totalProducts: total,
                progress: Math.round(((currentProductNumber - 1) / total) * 100),
                productId: product[`${companyId}_product_id`],
                productCode: product[`${companyId}_product_code`],
                productUrl: product.product_url,
                status: 'running',
                message: `Scraping product ${currentProductNumber} of ${total}`
            });

            const page = await browser.newPage();

            try {
                // Scrape
                const result = await scrapeOneProduct(product, currentProductNumber, page);
                scrapedData.push(result);

                // ── product_complete event ──────────────────────
                sendEvent('product_complete', {
                    productNumber: currentProductNumber,
                    totalProducts: total,
                    processedProducts: currentProductNumber,
                    progress: Math.round((currentProductNumber / total) * 100),
                    productId: product[`${companyId}_product_id`],
                    productCode: product[`${companyId}_product_code`],
                    status: 'success',
                    data: result,
                    message: `Product ${currentProductNumber} completed`
                });

            } catch (err) {
                console.error(`Error on product ${currentProductNumber}:`, err.message);
                // Store failed product for later retry
                failedProducts.push({
                    product,
                    productNumber: currentProductNumber
                });

                // Mark as pending in DB
                try {
                    await executeMongoUpdate(
                        { collection: 'ept_product_details_new_jiomart', cmpid },
                        {
                            [`${companyId}_product_id`]: product[`${companyId}_product_id`],
                            [`${companyId}_product_code`]: product[`${companyId}_product_code`]
                        },
                        {
                            $set: {
                                product_scrape_status: 'pending',
                                modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time')
                            }
                        }
                    );
                } catch (dbErr) {
                    console.error('DB update error:', dbErr);
                }

                sendEvent('product_complete', {
                    productNumber: currentProductNumber,
                    totalProducts: total,
                    processedProducts: currentProductNumber,
                    progress: Math.round((currentProductNumber / total) * 100),
                    productId: product[`${companyId}_product_id`],
                    productCode: product[`${companyId}_product_code`],
                    status: 'pending',
                    data: null,
                    message: `Product ${currentProductNumber} failed, will retry later`
                });
            } finally {
                await page.close().catch(() => {});
                // Update progress after each product (including failed)
                if (!isSingleProduct) {
                    await updateEndTimeInDb(
                        currentProductNumber,
                        'running',
                        cmpid,
                        companyId,
                        null,
                        cronName,
                        cronStartTime,
                        total
                    );
                }
            }

            await delay(100);
        }

        // ── Helper to scrape one product (returns result or throws) ──
        async function scrapeOneProduct(product, productNumber, page) {

            const productUrl = product.product_url;
            const productId = product[`${companyId}_product_id`];
            const productCode = product[`${companyId}_product_code`];
            const productPrice = product.product_price;

            // URL validation
            let hostname;
            try {
                hostname = new URL(productUrl).hostname;
            } catch {
                throw new Error('Invalid product URL');
            }
            if (!hostname.includes('jiomart')) {
                throw new Error('Only Jiomart URLs supported');
            }

            // ── Page setup ──────────────────────────────────────
            // Warm-up
            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
            await delay(1000);

            // Extra headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
                'Sec-Ch-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'Sec-Ch-UA-Mobile': '?0',
                'Sec-Ch-UA-Platform': '"Windows"',
            });
            await page.setViewport({ width: 1366, height: 768 });
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
            );

            // ── Navigation with retry (2 attempts) ──────────────
            let pageLoaded = false;
            let loadError = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    console.log(`Loading ${productId} - attempt ${attempt}/2`);
                    
                    await page.goto(productUrl, {
                        waitUntil: 'networkidle2',
                        timeout: 60000
                    });

                    pageLoaded = true;
                    break;
                } catch (err) {
                    loadError = err;
                    console.error(`Attempt ${attempt} failed for ${productId}: ${err.message}`);
                    if (attempt < 2) await delay(3000);
                }
            }
            if (!pageLoaded) {
                throw loadError || new Error('Page load failed after retries');
            }

            // ── Extract JSON ──────────────────────────────────

            let varProductPrice  = 'No Result';
            let varProductStock  = 'No Result';
            let varProductImage  = 'No Result';
            let varProductReview = 'No Result';
            let varProductRating = 'No Result';
            let scrapeStatus     = 'pending';

            if(await page.$('div.product-description__productDescriptionPdpContainer') === null) {

                varProductPrice  = 'No Result';
                varProductStock  = 'No Result';
                varProductImage  = 'No Result';
                varProductReview = 'No Result';
                varProductRating = 'No Result';
                scrapeStatus     = 'pending';

            }else{

                await page.waitForSelector('div.product-description__productInfoContent .PriceContainer__currentPrice',{ timeout: 6000 }).catch(() => {});

                const result = await page.evaluate(() => {
                    const pricedata = document.querySelector('div.product-description__productInfoContent .PriceContainer__currentPrice')?.textContent.replace(/"/g, "").trim();
                    let stockstatus = 'outofstock';
                    if (pricedata) {
                        stockstatus = 'instock';
                    }
                    const reviewCount = document.querySelector('#rnr-avg-widget .fe-text-primary-grey-80')?.textContent;
                    const ratingValue = document.querySelector('#rnr-avg-widget .fe-text-primary-grey-100')?.textContent;
                    const productimage = document.querySelector('img.product-description__mainImageImg')?.getAttribute('src');
                    // return product;\
                    return {
                        price: pricedata || '',
                        availability: stockstatus || '',
                        image: productimage || '',
                        review: reviewCount || 0,
                        rating: ratingValue || 0
                    };
                });

                //console.log(result);
                //console.log(product[`${companyId}_product_id`]);
                
                varProductPrice  = 'No Result';
                varProductStock  = 'No Result';
                varProductImage  = 'No Result';
                varProductReview = 'No Result';
                varProductRating = 'No Result';
                scrapeStatus     = 'pending';

                if (result !== null) {

                    const status = (result.availability || '').toLowerCase().trim();
                    varProductImage = result.image || 'No Result';
                    const cleanedreview = (result.review || '').replace(/[^0-9.]/g, '');
                    varProductReview = parseFloat(cleanedreview) || 0;
                    varProductRating = parseFloat(result.rating) || 0;
                    const cleanedPrice = (result.price || '').replace(/[^0-9.]/g, '');

                    if ((status.includes('instock')) && (cleanedPrice > 0)){
                        varProductPrice = parseFloat(cleanedPrice);
                        varProductStock = 'In stock';
                    } 
                    else if(status.includes('outofstock') || status.includes('currently unavailable')){
                        varProductStock = 'Out Of Stock';
                    }
                    scrapeStatus = 'completed';
                } 
            }

            const modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

            // Update price change
            updatePriceChangeData(
                scrapeStatus,
                productPrice,
                varProductPrice,
                productId,
                productCode,
                cronName,
                cmpid,
                companyId
            );

            // Update DB
            await executeMongoUpdate(
                { collection: 'ept_product_details_new_jiomart', cmpid },
                { [`${companyId}_product_id`]: productId, [`${companyId}_product_code`]: productCode },
                {
                    $set: {
                        product_price: varProductPrice,
                        product_stock: varProductStock,
                        product_image: varProductImage,
                        product_review: varProductReview,
                        product_rating: varProductRating,
                        modified_date: modifiedDate,
                        product_scrape_status: scrapeStatus
                    }
                }
            );

            return {
                product_ean_id: productId,
                product_code: productCode,
                product_price: varProductPrice,
                product_stock: varProductStock,
                modified_date: modifiedDate,
                scrape_status: scrapeStatus
            };
        }

        // ── Retry failed products ──────────────────────────────────
        if (failedProducts.length > 0 && !clientDisconnected) {
            console.log(`Retrying ${failedProducts.length} failed products...`);
            sendEvent('step', {
                step: 'retry',
                status: 'running',
                message: `Retrying ${failedProducts.length} failed products...`
            });

            let retryCount = 0;
            for (const failed of failedProducts) {
                if (clientDisconnected) break;
                retryCount++;
                const product = failed.product;
                const originalNumber = failed.productNumber;

                sendEvent('product_start', {
                    productNumber: originalNumber,
                    totalProducts: total,
                    progress: Math.round(((originalNumber - 1) / total) * 100),
                    productId: product[`${companyId}_product_id`],
                    productCode: product[`${companyId}_product_code`],
                    productUrl: product.product_url,
                    status: 'retry',
                    message: `Retrying product ${originalNumber} (attempt 2)`
                });

                const page = await browser.newPage();
                try {
                    const result = await scrapeOneProduct(product, originalNumber, page);
                    scrapedData.push(result);

                    sendEvent('product_complete', {
                        productNumber: originalNumber,
                        totalProducts: total,
                        processedProducts: originalNumber, // Note: processed count is not increased; we keep original number
                        progress: Math.round((originalNumber / total) * 100),
                        productId: product[`${companyId}_product_id`],
                        productCode: product[`${companyId}_product_code`],
                        status: 'success',
                        data: result,
                        message: `Retry successful for product ${originalNumber}`
                    });
                } catch (err) {
                    console.error(`Retry failed for ${originalNumber}:`, err.message);
                    // Mark as pending (already pending, but update modified date)
                    try {
                        await executeMongoUpdate(
                            { collection: 'ept_product_details_new_jiomart', cmpid },
                            {
                                [`${companyId}_product_id`]: product[`${companyId}_product_id`],
                                [`${companyId}_product_code`]: product[`${companyId}_product_code`]
                            },
                            {
                                $set: {
                                    modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time')
                                }
                            }
                        );
                    } catch (dbErr) {
                        console.error('DB update error on retry:', dbErr);
                    }
                    sendEvent('product_complete', {
                        productNumber: originalNumber,
                        totalProducts: total,
                        processedProducts: originalNumber,
                        progress: Math.round((originalNumber / total) * 100),
                        productId: product[`${companyId}_product_id`],
                        productCode: product[`${companyId}_product_code`],
                        status: 'pending',
                        data: null,
                        message: `Retry failed for product ${originalNumber}`
                    });
                } finally {
                    await page.close().catch(() => {});
                }
                await delay(100);
            }
        }

        // ── Final summary ──────────────────────────────────────────
        const endTime = new Date(
            `${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`
        );
        const diffMs = endTime - startTime;
        const totalMins = +(diffMs / 60000).toFixed(2);

        if (!isSingleProduct) {
            await updateEndTimeInDb(
                productCount,
                'ending',
                cmpid,
                companyId,
                totalMins,
                cronName,
                cronStartTime,
                total
            );
        }

        sendEvent('complete', {
            status: true,
            message: 'Scraping completed',
            totalProducts: total,
            totalProcessed: productCount,
            progress: 100,
            totalMinutes: totalMins,
            data: scrapedData
        });

        res.end();

    } catch (err) {
        console.error('Jiomart scraper error:', err);
        if (!res.writableEnded) {
            sendEvent('error', {
                status: false,
                message: err.message || 'Jiomart scraping failed'
            });
            res.end();
        }
    } finally {
        if (browser) {
            console.log('Closing browser...');
            await browser.close().catch(() => {});
        }
    }
}

module.exports = { jiomartScraper };