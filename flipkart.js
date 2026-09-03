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

const cronName = 'flipkart';

async function flipkartScraper(req, res) {
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
        console.log('Flipkart client disconnected');
    });

    // ── Start event ──────────────────────────────────────────────
    sendEvent('start', {
        status: true,
        message: 'Flipkart scraping started',
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

        let pincode = await getStorePincode(companyId);
        if (pincode === null) {
            pincode = req.query.pincode || '600018';
        }

        // ── SET PINCODE GLOBALLY (if provided) ──────────────────
        if (pincode) {
            sendEvent('step', {
                step: 'pincode',
                status: 'running',
                message: `Setting global pincode to ${pincode}...`
            });
            try {
                await setGlobalPincode(browser, pincode, sendEvent);
                sendEvent('step', {
                    step: 'pincode',
                    status: 'completed',
                    message: `Pincode ${pincode} set successfully`
                });
            } catch (err) {
                console.error('Failed to set pincode:', err.message);
                sendEvent('step', {
                    step: 'pincode',
                    status: 'failed',
                    message: `Pincode setting failed: ${err.message}`
                });
                // Continue anyway – product pages may show default pricing
            }
        }

        // ── Fetch products ──────────────────────────────────────
        sendEvent('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching Flipkart products...'
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
            { collection: 'ept_product_details_new_flipkart', cmpid },
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

        const scrapedData = [];
        const failedProducts = []; // will store { product, productNumber }

        // ── Helper to scrape one product (returns result or throws) ──
        async function scrapeOneProduct(product, productNumber, page) {
            const productUrl = product.product_url;
            const productId = product[`${companyId}_product_id`];
            const productCode = product[`${companyId}_product_code`];

            const urlWithCacheBuster = productUrl + (productUrl.includes('?') ? '&' : '?') + `_=${Date.now()}`;

            // URL validation
            let hostname;
            try {
                hostname = new URL(productUrl).hostname;
            } catch {
                throw new Error('Invalid product URL');
            }
            if (!hostname.includes('flipkart')) {
                throw new Error('Only Flipkart URLs supported');
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
                    await page.goto(urlWithCacheBuster, { 
                        waitUntil: 'domcontentloaded', 
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

            // ── Extract JSON‑LD ──────────────────────────────────
            const jsonLdExists = await page.$('#jsonLD');
            let varProductPrice = 'No Result';
            let varProductStock = 'No Result';
            let varProductImage = 'No Result';
            let varProductReview = 'No Result';
            let varProductRating = 'No Result';
            let scrapeStatus = 'pending';

            if (jsonLdExists) {
                const result = await page.evaluate(() => {
                    const jsonLd = document.querySelector('#jsonLD');
                    if (!jsonLd) return null;
                    try {
                        const parsed = JSON.parse(jsonLd.textContent);
                        if (!Array.isArray(parsed) || parsed.length === 0) return null;
                        const data = parsed[0];
                        const buynowelements = document.querySelectorAll('div._1psv1zeb9._1psv1ze0._1psv1zeku._1psv1ze6r');
                        let stockstatus;
                        if(buynowelements.length > 1){
                            const buytext = buynowelements[1]?.textContent.trim().toLocaleLowerCase();
                            stockstatus = (buytext.includes('buy')) ? 'instock' : 'outofstock';
                        }
                        return {
                            price: data.offers?.price ? `₹${data.offers.price}` : '',
                            availability: stockstatus || data.offers?.availability,
                            image: Array.isArray(data.image) ? data.image[0] : data.image || '',
                            review: data.aggregateRating?.ratingCount || 0,
                            rating: data.aggregateRating?.ratingValue || 0
                        };
                    } catch {
                        return null;
                    }
                });

                if (result) {
                    const availability = (result.availability || '').toLowerCase().trim();
                    varProductImage = result.image || 'No Result';
                    varProductReview = result.review != null ? Number(result.review) : 'No Result';
                    varProductRating = result.rating != null ? Number(result.rating) : 'No Result';
                    const cleanedPrice = (result.price || '').replace(/[^0-9.]/g, '');

                    if ((availability.includes('instock')) &&  (cleanedPrice > 0)) {
                        varProductPrice = parseFloat(cleanedPrice) || 'No Result';
                        varProductStock = 'In stock';
                    } else if (availability.includes('outofstock') || availability.includes('currently unavailable')) {
                        varProductStock = 'Out Of Stock';
                    }
                    scrapeStatus = 'completed';
                }
            }

            const modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

            // Update price change
            updatePriceChangeData(
                scrapeStatus,
                product.product_price,
                varProductPrice,
                productId,
                productCode,
                cronName,
                cmpid,
                companyId
            );

            // Update DB
            try {
                await executeMongoUpdate(
                    { collection: 'ept_product_details_new_flipkart', cmpid },
                    {[`${companyId}_product_id`]: productId,[`${companyId}_product_code`]: productCode},
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
                // console.log(`MongoDB update successful for product: ${productId}`);
            }
            catch(error){
                // console.error(`MongoDB update failed for product ${productId}:`,error.message);
            }

            return {
                product_ean_id: productId,
                product_code: productCode,
                product_price: varProductPrice,
                product_stock: varProductStock,
                modified_date: modifiedDate,
                scrape_status: scrapeStatus
            };
        }

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
                        { collection: 'ept_product_details_new_flipkart', cmpid },
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
                            { collection: 'ept_product_details_new_flipkart', cmpid },
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
        console.error('Flipkart scraper error:', err);
        if (!res.writableEnded) {
            sendEvent('error', {
                status: false,
                message: err.message || 'Flipkart scraping failed'
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

// async function setGlobalPincode(browser, pincode, sendEvent) {
//     const page = await browser.newPage();

//     // ── Helper delay ──────────────────────────────────────────
//     const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

//     // ── Step: Clear cookies & cache ──────────────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_clear',
//             status: 'running',
//             message: 'Clearing browser cookies and cache...'
//         });
//     }
//     const client = await page.target().createCDPSession();
//     await client.send('Network.clearBrowserCookies');
//     await client.send('Network.clearBrowserCache');
//     console.log('Cleared cookies and cache.');
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_clear',
//             status: 'completed',
//             message: 'Cookies and cache cleared.'
//         });
//     }

//     // ── Step: Block heavy resources ──────────────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_block',
//             status: 'running',
//             message: 'Blocking non-essential resources (images, styles, fonts)...'
//         });
//     }
//     await page.setRequestInterception(true);
//     page.on('request', (req) => {
//         const type = req.resourceType();
//         if (['image', 'stylesheet', 'font', 'media', 'websocket', 'manifest', 'other'].includes(type)) {
//             req.abort();
//         } else {
//             req.continue();
//         }
//     });
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_block',
//             status: 'completed',
//             message: 'Resource blocking enabled.'
//         });
//     }

//     // ── Setup viewport, UA, headers ──────────────────────────
//     await page.setViewport({ width: 1366, height: 768 });
//     await page.setUserAgent(
//         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
//     );
//     await page.setExtraHTTPHeaders({
//         'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
//     });

//     // ── Step: Navigate to Flipkart ───────────────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_navigate',
//             status: 'running',
//             message: 'Loading Flipkart homepage (lightweight)...'
//         });
//     }
//     try {
//         await page.goto('https://www.flipkart.com', {
//             waitUntil: 'commit',
//             timeout: 30000
//         });
//         console.log('Homepage loaded (commit).');
//         if (sendEvent) {
//             sendEvent('step', {
//                 step: 'pincode_navigate',
//                 status: 'completed',
//                 message: 'Homepage loaded.'
//             });
//         }
//     } catch (err) {
//         if (sendEvent) {
//             sendEvent('step', {
//                 step: 'pincode_navigate',
//                 status: 'failed',
//                 message: `Navigation failed: ${err.message}`
//             });
//         }
//         throw err;
//     }

//     // ── Step: Close login popup ──────────────────────────────
//     try {
//         const closeBtn = await page.waitForSelector('span.b3wTlE', { timeout: 5000 });
//         if (closeBtn) {
//             await closeBtn.click();
//             await delay(1000);
//             console.log('Login popup closed.');
//         }
//     } catch (_) { /* no popup */ }

//     // ── Step: Click location selector ────────────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_location',
//             status: 'running',
//             message: 'Opening delivery location selector...'
//         });
//     }
//     try {
//         const locationSelector = await page.waitForSelector(
//             'a._3n8fna1co._3n8fna10j._3n8fnaod._3n8fna1._3n8fnac7._1i2djtb9._9nihix1d._1i2djti0',
//             { timeout: 10000 }
//         );
//         if (locationSelector) {
//             await locationSelector.click();
//             await delay(1000);
//             console.log('locationSelector clicked.');
//             if (sendEvent) {
//                 sendEvent('step', {
//                     step: 'pincode_location',
//                     status: 'completed',
//                     message: 'Location selector opened.'
//                 });
//             }
//         } else {
//             throw new Error('Location selector not found');
//         }
//     } catch (_) {
//         // fallback: try clicking any input with 'pincode'
//         try {
//             const loc = await page.waitForSelector('input[placeholder*="pincode"]', { timeout: 5000 });
//             await loc.click();
//             console.log('Clicked pincode input directly.');
//             if (sendEvent) {
//                 sendEvent('step', {
//                     step: 'pincode_location',
//                     status: 'completed',
//                     message: 'Pincode input focused directly.'
//                 });
//             }
//         } catch (__) {
//             console.log('Could not find location selector; will try input directly.');
//             if (sendEvent) {
//                 sendEvent('step', {
//                     step: 'pincode_location',
//                     status: 'warning',
//                     message: 'Location selector not found, proceeding to input.'
//                 });
//             }
//         }
//     }

//     // ── Step: Find pincode input ─────────────────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_find_input',
//             status: 'running',
//             message: 'Searching for pincode input field...'
//         });
//     }
//     let pincodeInput = null;
//     const selectors = [
//         'input[placeholder*="Search by area, street name, pin code"]',
//         'input[class*="pincode"]',
//         'input[placeholder*="Enter delivery pincode"]'
//     ];
//     for (const sel of selectors) {
//         try {
//             pincodeInput = await page.waitForSelector(sel, { timeout: 5000 });
//             if (pincodeInput) {
//                 console.log(`pincodeInput found with: ${sel}`);
//                 break;
//             }
//         } catch (_) { /* try next */ }
//     }

//     if (!pincodeInput) {
//         if (sendEvent) {
//             sendEvent('step', {
//                 step: 'pincode_find_input',
//                 status: 'failed',
//                 message: 'Pincode input field not found'
//             });
//         }
//         throw new Error('Pincode input field not found');
//     }
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_find_input',
//             status: 'completed',
//             message: 'Pincode input found.'
//         });
//     }

//     // ── Step: Type pincode ────────────────────────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_type',
//             status: 'running',
//             message: `Typing pincode ${pincode}...`
//         });
//     }
//     await pincodeInput.click({ clickCount: 3 });
//     await pincodeInput.type(pincode, { delay: 100 });
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_type',
//             status: 'completed',
//             message: `Pincode ${pincode} typed.`
//         });
//     }

//     // ── Step: Wait for suggestions ────────────────────────────
//     await delay(2000);

//     // ── Step: Select suggestion ───────────────────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_suggestion',
//             status: 'running',
//             message: 'Waiting for suggestions and selecting matching one...'
//         });
//     }
//     try {
//         await page.waitForSelector('#msite-bottomsheet', { timeout: 5000 });

//         const clickPosition = await page.evaluate((pincode) => {
//             const elements = document.querySelectorAll(
//                 '#msite-bottomsheet div[class*="css-g5y9jx"] .css-146c3p1.r-dnmrzs.r-1udh08x.r-1udbk01.r-3s2u2q.r-1iln25a'
//             );
//             for (const el of elements) {
//                 if (el.querySelector('div[class*="css-g5y9jx"]')) continue;
//                 const text = el.innerText?.trim() || '';
//                 if (!text.includes(pincode)) continue;
//                 if (text.includes('Select delivery address')) continue;
//                 const rect = el.getBoundingClientRect();
//                 if (rect.width === 0 || rect.height === 0) continue;
//                 return {
//                     x: rect.left + rect.width / 2,
//                     y: rect.top + rect.height / 2,
//                     text
//                 };
//             }
//             return null;
//         }, pincode);

//         if (clickPosition) {
//             console.log(`🎯 Clicking suggestion: "${clickPosition.text}"`);
//             await page.mouse.click(clickPosition.x, clickPosition.y);
//             if (sendEvent) {
//                 sendEvent('step', {
//                     step: 'pincode_suggestion',
//                     status: 'completed',
//                     message: `Suggestion "${clickPosition.text}" selected.`
//                 });
//             }
//         } else {
//             console.log('⚠️ No suggestion found, pressing Enter');
//             await page.keyboard.press('Enter');
//             if (sendEvent) {
//                 sendEvent('step', {
//                     step: 'pincode_suggestion',
//                     status: 'completed',
//                     message: 'No suggestion – pressed Enter.'
//                 });
//             }
//         }
//     } catch (err) {
//         console.error('Suggestion handling failed, pressing Enter', err.message);
//         await page.keyboard.press('Enter');
//         if (sendEvent) {
//             sendEvent('step', {
//                 step: 'pincode_suggestion',
//                 status: 'warning',
//                 message: `Suggestion error, pressed Enter: ${err.message}`
//             });
//         }
//     }

//     // ── Step: Handle "Try Again" / "Confirm" ──────────────────
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_confirm',
//             status: 'running',
//             message: 'Handling Try Again / Confirm buttons...'
//         });
//     }
//     await handleTryAgainOrConfirm(page);
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_confirm',
//             status: 'completed',
//             message: 'Confirmation handled.'
//         });
//     }

//     // ── Step: Wait for pincode to apply ──────────────────────
//     await delay(3000);
//     console.log(`✅ Pincode ${pincode} set successfully.`);
//     if (sendEvent) {
//         sendEvent('step', {
//             step: 'pincode_done',
//             status: 'completed',
//             message: `Pincode ${pincode} fully applied.`
//         });
//     }

//     await page.close();
// }

async function setGlobalPincode(browser, pincode, sendEvent) {
    const page = await browser.newPage();
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Helper to perform navigation with retry
    async function navigateToFlipkart() {
        const maxAttempts = 2;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await page.goto('https://www.flipkart.com', {
                    waitUntil: 'domcontentloaded',   // valid in Puppeteer
                    timeout: 45000                    // 45 seconds
                });

                // await delay(100000);
                return true;
            } catch (err) {
                console.error(`Navigation attempt ${attempt} failed: ${err.message}`);
                if (attempt === maxAttempts) throw err;
                await delay(3000);
                // Refresh page state if needed
            }
        }
        return false;
    }

    // ── Step: Clear cookies & cache ──────────────────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_clear',
            status: 'running',
            message: 'Clearing browser cookies and cache...'
        });
    }
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_clear',
            status: 'completed',
            message: 'Cookies and cache cleared.'
        });
    }

    // ── Step: Block heavy resources ──────────────────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_block',
            status: 'running',
            message: 'Blocking non-essential resources (images, styles, fonts)...'
        });
    }
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'font', 'media'].includes(type)) {
            req.abort();
        } else {
            req.continue();
        }
    });
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_block',
            status: 'completed',
            message: 'Resource blocking enabled.'
        });
    }

    // ── Setup viewport, UA, headers ──────────────────────────
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // ── Step: Navigate to Flipkart (with retry) ──────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_navigate',
            status: 'running',
            message: 'Loading Flipkart homepage (lightweight)...'
        });
    }
    try {
        await navigateToFlipkart();
        console.log('Homepage loaded.');
        if (sendEvent) {
            sendEvent('step', {
                step: 'pincode_navigate',
                status: 'completed',
                message: 'Homepage loaded.'
            });
        }
    } catch (err) {
        if (sendEvent) {
            sendEvent('step', {
                step: 'pincode_navigate',
                status: 'failed',
                message: `Navigation failed: ${err.message}`
            });
        }
        throw err;
    }

    // ── Close login popup ──────────────────────────────────────
    try {
        const closeBtn = await page.waitForSelector('span.b3wTlE', { timeout: 5000 });
        if (closeBtn) {
            await closeBtn.click();
            await delay(1000);
        }
    } catch (_) { /* no popup */ }

    const context = browser.defaultBrowserContext();
    await context.overridePermissions('https://www.flipkart.com', []);

    // ── Click location selector ────────────────────────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_location',
            status: 'running',
            message: 'Opening delivery location selector...'
        });
    }
    try {
        const locationSelector = await page.waitForSelector(
            'a._3n8fna1co._3n8fna10j._3n8fnaod._3n8fna1._3n8fnac7._1i2djtb9._9nihix1d._1i2djti0',
            { timeout: 10000 }
        );
        if (locationSelector) {
            await locationSelector.click();
            await delay(1000);
            if (sendEvent) {
                sendEvent('step', {
                    step: 'pincode_location',
                    status: 'completed',
                    message: 'Location selector opened.'
                });
            }
        } else {
            throw new Error('Location selector not found');
        }
    } catch (_) {
        try {
            const loc = await page.waitForSelector('input[placeholder*="pincode"]', { timeout: 5000 });
            await loc.click();
            if (sendEvent) {
                sendEvent('step', {
                    step: 'pincode_location',
                    status: 'completed',
                    message: 'Pincode input focused directly.'
                });
            }
        } catch (__) {
            if (sendEvent) {
                sendEvent('step', {
                    step: 'pincode_location',
                    status: 'warning',
                    message: 'Location selector not found, proceeding to input.'
                });
            }
        }
    }

    // ── Find pincode input ─────────────────────────────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_find_input',
            status: 'running',
            message: 'Searching for pincode input field...'
        });
    }
    let pincodeInput = null;
    const selectors = [
        'input[placeholder*="Search by area, street name, pin code"]',
        'input[class*="pincode"]',
        'input[placeholder*="Enter delivery pincode"]'
    ];
    for (const sel of selectors) {
        try {
            pincodeInput = await page.waitForSelector(sel, { timeout: 5000 });
            if (pincodeInput) break;
        } catch (_) { /* try next */ }
    }
    if (!pincodeInput) {
        if (sendEvent) {
            sendEvent('step', {
                step: 'pincode_find_input',
                status: 'failed',
                message: 'Pincode input field not found'
            });
        }
        throw new Error('Pincode input field not found');
    }
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_find_input',
            status: 'completed',
            message: 'Pincode input found.'
        });
    }

    // ── Type pincode ────────────────────────────────────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_type',
            status: 'running',
            message: `Typing pincode ${pincode}...`
        });
    }
    await pincodeInput.click({ clickCount: 3 });
    await pincodeInput.type(pincode, { delay: 500 });
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_type',
            status: 'completed',
            message: `Pincode ${pincode} typed.`
        });
    }

    // ── Wait for suggestions ────────────────────────────────────
    await delay(2000);

    // ── Select suggestion ──────────────────────────────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_suggestion',
            status: 'running',
            message: 'Waiting for suggestions and selecting matching one...'
        });
    }
    try {
        await page.waitForSelector('#msite-bottomsheet', { timeout: 5000 });
        const clickPosition = await page.evaluate((pincode) => {
            const elements = document.querySelectorAll(
                '#msite-bottomsheet div[class*="css-g5y9jx"] .css-146c3p1.r-dnmrzs.r-1udh08x.r-1udbk01.r-3s2u2q.r-1iln25a'
            );
            for (const el of elements) {
                if (el.querySelector('div[class*="css-g5y9jx"]')) continue;
                const text = el.innerText?.trim() || '';
                if (!text.includes(pincode)) continue;
                if (text.includes('Select delivery address')) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                return {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    text
                };
            }
            return null;
        }, pincode);
        if (clickPosition) {
            await page.mouse.click(clickPosition.x, clickPosition.y);
            if (sendEvent) {
                sendEvent('step', {
                    step: 'pincode_suggestion',
                    status: 'completed',
                    message: `Suggestion "${clickPosition.text}" selected.`
                });
            }
        } else {
            await page.keyboard.press('Enter');
            if (sendEvent) {
                sendEvent('step', {
                    step: 'pincode_suggestion',
                    status: 'completed',
                    message: 'No suggestion – pressed Enter.'
                });
            }
        }
    } catch (err) {
        await page.keyboard.press('Enter');
        if (sendEvent) {
            sendEvent('step', {
                step: 'pincode_suggestion',
                status: 'warning',
                message: `Suggestion error, pressed Enter: ${err.message}`
            });
        }
    }

    // ── Handle "Try Again" / "Confirm" ──────────────────────────
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_confirm',
            status: 'running',
            message: 'Handling Try Again / Confirm buttons...'
        });
    }

    await delay(5000);

    await handleTryAgainOrConfirm(page);
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_confirm',
            status: 'completed',
            message: 'Confirmation handled.'
        });
    }

    // ── Wait for pincode to apply ──────────────────────────────
    await delay(3000);
    console.log(`✅ Pincode ${pincode} set successfully.`);
    if (sendEvent) {
        sendEvent('step', {
            step: 'pincode_done',
            status: 'completed',
            message: `Pincode ${pincode} fully applied.`
        });
    }

    await page.close();
}

async function handleTryAgainOrConfirm(page) {
    try {
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`🔄 Try Again / Confirm check ${attempt}/${maxAttempts}`);

            const result = await page.evaluate(() => {
                const elements = [
                    ...document.querySelectorAll(
                        'button, [role="button"], div, span'
                    )
                ];

                // First priority: Try Again
                for (const el of elements) {
                    const text = (el.innerText || el.textContent || '')
                        .trim()
                        .toLowerCase();

                    if (text !== 'try again') continue;

                    const rect = el.getBoundingClientRect();

                    if (
                        rect.width === 0 ||
                        rect.height === 0
                    ) {
                        continue;
                    }

                    return {
                        type: 'try_again',
                        text,
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2
                    };
                }

                // Second priority: Confirm
                for (const el of elements) {
                    const text = (el.innerText || el.textContent || '')
                        .trim()
                        .toLowerCase();

                    if (text !== 'confirm') continue;

                    const rect = el.getBoundingClientRect();

                    if (
                        rect.width === 0 ||
                        rect.height === 0
                    ) {
                        continue;
                    }

                    return {
                        type: 'confirm',
                        text,
                        x: rect.left + rect.width / 2,
                        y: rect.top + rect.height / 2
                    };
                }

                return null;
            });

            // Nothing found
            if (!result) {
                console.log('⚠️ No Try Again / Confirm button found');
                return;
            }

            console.log(
                `🎯 Found "${result.text}" at (${result.x}, ${result.y})`
            );

            // Click
            await page.mouse.click(
                result.x,
                result.y
            );

            console.log(`✅ Clicked "${result.text}"`);

            // If Confirm clicked, we're done
            if (result.type === 'confirm') {
                console.log('✅ Confirm clicked successfully');
                return;
            }

            // If Try Again clicked,
            // wait and check again for Confirm / Try Again
            if (result.type === 'try_again') {
                console.log(
                    '🔄 Try Again clicked. Waiting for next button...'
                );

                await new Promise(resolve =>
                    setTimeout(resolve, 1500)
                );
            }
        }

        console.log(
            `⚠️ Reached maximum ${maxAttempts} attempts`
        );

    } catch (err) {
        console.error(
            '❌ handleTryAgainOrConfirm error:',
            err.message
        );
    }
}

// ── Helper delay (reused) ───────────=
// For simplicity, I'll add a small delay helper outside.
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { flipkartScraper };