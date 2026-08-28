const puppeteer = require('puppeteer');
const {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb
} = require('./utils/cronTime');

const { updatePriceChangeData } = require('./utils/priceChange');
const { getStorePincode } = require('./utils/pinCode');
const { PincodeApplied } = require('./utils/pincodeApplied');

const {
    executeMongoFind,
    executeMongoCount,
    executeMongoUpdate
} = require('./mongo');

const cronName = 'amazon';

// Configuration constants
const CONFIG = {
    MAX_CONCURRENT_PAGES: 2, // Reduced to prevent memory issues
    PAGE_TIMEOUT: 45000,
    DELAY_BETWEEN_PRODUCTS: 500,
    MONGO_RETRY_DELAY: 2000,
    MAX_MONGO_RETRIES: 3,
    BROWSER_ARGS: [
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
        '--js-flags=--max-old-space-size=512',
        '--memory-pressure-off',
        '--disable-ipc-flooding-protection',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-domain-reliability',
        '--disable-file-system',
        '--disable-local-storage',
        '--disable-session-crashed-bubble',
        '--disable-translate',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--max_old_space_size=512'
    ]
};

async function amazonScraper(req, res) {

    const delay = (ms) =>
        new Promise(resolve => setTimeout(resolve, ms));

    let browser;
    let pagePool = [];
    let isShuttingDown = false;

    /*
    ============================================================
    SSE RESPONSE HELPERS
    ============================================================
    */

    const sendEvent = (event, data) => {

        if (res.writableEnded || isShuttingDown) {
            return;
        }

        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);

            if (typeof res.flush === 'function') {
                res.flush();
            }
        } catch (error) {
            console.error('Error sending event:', error.message);
        }
    };

    /*
    ============================================================
    SAFE MONGO OPERATIONS WITH RETRY
    ============================================================
    */

    async function safeMongoFind(collection, filter, projection, retries = CONFIG.MAX_MONGO_RETRIES) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await executeMongoFind(collection, filter, projection);
            } catch (error) {
                console.error(`MongoDB find attempt ${attempt} failed:`, error.message);
                
                if (attempt === retries) {
                    throw error;
                }
                
                // Wait before retry
                await delay(CONFIG.MONGO_RETRY_DELAY * attempt);
            }
        }
    }

    async function safeMongoUpdate(collection, filter, update, retries = CONFIG.MAX_MONGO_RETRIES) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await executeMongoUpdate(collection, filter, update);
            } catch (error) {
                console.error(`MongoDB update attempt ${attempt} failed:`, error.message);
                
                if (attempt === retries) {
                    throw error;
                }
                
                await delay(CONFIG.MONGO_RETRY_DELAY * attempt);
            }
        }
    }

    /*
    ============================================================
    PAGE POOL MANAGEMENT
    ============================================================
    */
    
    const getPageFromPool = async () => {
        while (pagePool.length > 0) {
            const page = pagePool.pop();
            try {
                await page.evaluate(() => 1);
                return page;
            } catch (error) {
                try { await page.close(); } catch (e) {}
            }
        }
        
        const newPage = await browser.newPage();
        
        // Optimize page settings
        await newPage.setRequestInterception(true);
        
        // Block unnecessary resources
        newPage.on('request', (req) => {
            const resourceType = req.resourceType();
            if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        await newPage.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        );
        
        await newPage.setViewport({
            width: 1366,
            height: 768
        });
        
        // Disable unnecessary features
        await newPage.evaluateOnNewDocument(() => {
            const style = document.createElement('style');
            style.textContent = `
                * {
                    animation-duration: 0s !important;
                    transition-duration: 0s !important;
                }
            `;
            document.head.appendChild(style);
            
            // Prevent infinite scrolling
            window.addEventListener('scroll', (e) => {
                e.stopPropagation();
            }, true);
        });
        
        return newPage;
    };
    
    const returnPageToPool = (page) => {
        if (page && !page.isClosed() && !isShuttingDown) {
            try {
                page.evaluate(() => {
                    if (window.performance && window.performance.navigation) {
                        window.performance.navigation.type = 2;
                    }
                    if (window._cf) delete window._cf;
                    if (window._csrf) delete window._csrf;
                }).catch(() => {});
                
                page.goto('about:blank', { waitUntil: 'domcontentloaded' })
                    .catch(() => {});
            } catch (e) {}
            
            if (pagePool.length < CONFIG.MAX_CONCURRENT_PAGES) {
                pagePool.push(page);
            } else {
                page.close().catch(() => {});
            }
        }
    };

    /*
    ============================================================
    REQUEST VALIDATION
    ============================================================
    */

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
    const pincode = req.query.pincode || '110001';

    const isSingleProduct = !!(ean && itemcode);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    let clientDisconnected = false;

    req.on('close', () => {
        clientDisconnected = true;
        console.log('Amazon client disconnected');
    });

    /*
    ============================================================
    SAFE SHUTDOWN
    ============================================================
    */

    const gracefulShutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        console.log('Starting graceful shutdown...');
        
        // Close all pages
        while (pagePool.length > 0) {
            const page = pagePool.pop();
            try {
                if (!page.isClosed()) {
                    await page.close();
                }
            } catch (error) {
                console.error('Page close error:', error);
            }
        }

        if (browser) {
            console.log('Closing browser...');
            try {
                await browser.close();
            } catch (error) {
                console.error('Browser close error:', error);
            }
        }
    };

    sendEvent('start', {
        status: true,
        message: 'Amazon scraping started',
        cmpid,
        companyId,
        isSingleProduct,
        pincode
    });

    try {
        sendEvent('step', {
            step: 'browser',
            status: 'running',
            message: 'Launching browser...'
        });

        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: CONFIG.BROWSER_ARGS,
            timeout: 30000,
            devtools: false,
            ignoreDefaultArgs: [
                '--enable-automation',
                '--disable-web-security'
            ],
            defaultViewport: null
        });

        sendEvent('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching Amazon products...'
        });

        const filter = {
            status: 'active',
            product_scrape_status: {
                $in: ['pending', 'completed']
            },
            product_url: {
                $nin: ['', null, 'No Result']
            }
        };

        if (isSingleProduct) {
            filter[`${companyId}_product_id`] = ean;
            filter[`${companyId}_product_code`] = itemcode;
        }

        // Use safe MongoDB operations with retry
        let products;
        try {
            products = await safeMongoFind(
                {
                    collection: 'ept_product_details_new_amazon',
                    cmpid
                },
                filter,
                { _id: 0 }
            );
        } catch (error) {
            console.error('Failed to fetch products from MongoDB:', error);
            sendEvent('error', {
                status: false,
                message: 'Database connection error. Please try again.'
            });
            res.end();
            return;
        }

        if (!products || products.length === 0) {
            sendEvent('complete', {
                status: true,
                message: 'Competitor products not found',
                totalProcessed: 0
            });
            res.end();
            return;
        }

        let existingProducts;
        try {
            existingProducts = await safeMongoFind(
                {
                    collection: 'ept_product_details_new',
                    cmpid
                },
                { status: 'active' },
                {
                    _id: 0,
                    product_ean_id: 1,
                    product_code: 1
                }
            );
        } catch (error) {
            console.error('Failed to fetch existing products:', error);
            // Continue with empty existing products
            existingProducts = [];
        }

        const productMap = new Set();
        existingProducts.forEach((row) => {
            productMap.add(`${row.product_ean_id}_${row.product_code}`);
        });

        const ArrGetProductInfo = products.filter((arrTmp) => {
            const key = `${arrTmp[`${companyId}_product_id`]}_${arrTmp[`${companyId}_product_code`]}`;
            return productMap.has(key);
        });

        products.length = 0;
        existingProducts.length = 0;

        if (ArrGetProductInfo.length === 0) {
            sendEvent('complete', {
                status: true,
                message: 'Active products not found',
                totalProcessed: 0
            });
            res.end();
            return;
        }

        let productCount = 0;
        let successfulScrapes = 0;
        let failedScrapes = 0;
        const ScrapingProductCount = ArrGetProductInfo.length;
        const startTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
        const cronStartTime = getCurrentIndTimeInfo();

        if (!isSingleProduct) {
            try {
                await updateStartTimeInDb(cmpid, companyId, cronName, ScrapingProductCount);
            } catch (error) {
                console.error('Failed to update start time:', error);
            }
        }

        sendEvent('progress', {
            status: 'running',
            totalProducts: ScrapingProductCount,
            processedProducts: 0,
            progress: 0,
            message: `${ScrapingProductCount} products found`
        });

        let dbPincode = await getStorePincode(companyId);
        if (dbPincode === null) {
            dbPincode = req.query.pincode || '600008';
        }

        const homepage = "https://www.amazon.in/";
        const pincodeSelectors = {
            container: '#nav-global-location-data-modal-action',
            inputfiled: '#GLUXZipUpdateInput',
            applyfield: '#GLUXZipUpdate-announce'
        };

        let currentAppliedPincode = dbPincode;

        try {
            const initialPincodeResult = await PincodeApplied(
                browser,
                dbPincode,
                cronName,
                homepage,
                pincodeSelectors,
                sendEvent
            );

            if (initialPincodeResult && initialPincodeResult.success) {
                currentAppliedPincode = initialPincodeResult.pincode || dbPincode;
                console.log('Initial pincode applied:', currentAppliedPincode);
            }
        } catch (error) {
            console.error('Pincode application error:', error.message);
        }

        /*
        ========================================================
        OPTIMIZED NAVIGATION
        ========================================================
        */

        async function navigateToPage(page, url) {
            try {
                // Try with domcontentloaded first
                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                return true;
            } catch (error) {
                console.log('DOMContentLoaded timeout, trying load...');
                
                try {
                    await page.goto(url, {
                        waitUntil: 'load',
                        timeout: 15000
                    });
                    return true;
                } catch (error2) {
                    console.log('Load timeout, trying networkidle0...');
                    
                    try {
                        await page.goto(url, {
                            waitUntil: 'networkidle0',
                            timeout: 15000
                        });
                        return true;
                    } catch (error3) {
                        console.log('All navigation strategies failed');
                        return false;
                    }
                }
            }
        }

        /*
        ========================================================
        PROCESS SINGLE PRODUCT
        ========================================================
        */
        
        async function processSingleProduct(product) {
            if (clientDisconnected || isShuttingDown) {
                return;
            }

            const productUrl = product.product_url;
            const productId = product[`${companyId}_product_id`];
            const productCode = product[`${companyId}_product_code`];
            
            let hostname;
            try {
                hostname = new URL(productUrl).hostname;
            } catch (error) {
                console.error('Invalid product URL:', productUrl);
                sendEvent('product_error', {
                    productId,
                    productCode,
                    status: 'error',
                    message: 'Invalid product URL'
                });
                failedScrapes++;
                return;
            }

            if (!hostname.includes('amazon')) {
                sendEvent('product_error', {
                    productId,
                    productCode,
                    status: 'error',
                    message: 'Only Amazon URLs supported'
                });
                failedScrapes++;
                return;
            }

            productCount++;
            const currentProductNumber = productCount;
            const currentProgress = Math.round(((currentProductNumber - 1) / ScrapingProductCount) * 100);

            sendEvent('product_start', {
                productNumber: currentProductNumber,
                totalProducts: ScrapingProductCount,
                progress: currentProgress,
                productId,
                productCode,
                productUrl,
                status: 'running',
                message: `Scraping product ${currentProductNumber} of ${ScrapingProductCount}`
            });

            let varProductPrice = 'No Result';
            let varProductStock = 'No Result';
            let varProductImage = 'No Result';
            let varProductReview = 'No Result';
            let varProductRating = 'No Result';
            let scrapeStatus = 'pending';
            let modifiedDate;

            let page = null;

            try {
                sendEvent('product_step', {
                    productNumber: currentProductNumber,
                    productId,
                    productCode,
                    step: 'page_loading',
                    status: 'running',
                    message: 'Opening Amazon product page...'
                });

                page = await getPageFromPool();

                const navigationSuccess = await navigateToPage(page, productUrl);
                
                if (!navigationSuccess) {
                    throw new Error('Failed to load page after multiple attempts');
                }

                sendEvent('product_step', {
                    productNumber: currentProductNumber,
                    productId,
                    productCode,
                    step: 'page_loaded',
                    status: 'completed',
                    message: 'Page loaded successfully'
                });

                // Check if product title exists
                const productTitleExists = await page.waitForSelector('#productTitle', { 
                    timeout: 5000 
                }).catch(() => null);

                if (!productTitleExists) {
                    sendEvent('product_step', {
                        productNumber: currentProductNumber,
                        productId,
                        productCode,
                        step: 'product_title',
                        status: 'failed',
                        message: 'Product title not found'
                    });
                    failedScrapes++;
                } else {
                    sendEvent('product_step', {
                        productNumber: currentProductNumber,
                        productId,
                        productCode,
                        step: 'extracting',
                        status: 'running',
                        message: 'Extracting product information...'
                    });

                    const result = await page.evaluate(() => {

                        const getText = (selector) => {
                            const el = document.querySelector(selector);
                            return el ? el.textContent.trim() : '';
                        };
                        const getAttr = (selector, attr) => {
                            const el = document.querySelector(selector);
                            return el ? el.getAttribute(attr) : '';
                        };
                      
                        const stockStatus = document.querySelectorAll(
                            '.a-size-medium a-color-base primary-availability-message'
                        ).length;

                        const offerPrice = document.querySelector(
                            'span[class*="priceToPay"] span.a-price-whole'
                        )?.textContent.trim() || '';
                        
                        return {
                            price: offerPrice,
                            stock: stockStatus,
                            image: getAttr('#landingImage', 'src'),
                            review: getText('#acrCustomerReviewText') || 0,
                            rating: getText('.mvt-cm-cr-review-stars-mini-popover span') || 0
                        };
                    });

                    console.log(result);

                    if (result !== null) {

                        varProductImage = result.image || 'No Result';
                        varProductReview = result.review ? parseFloat(result.review.replace(/[^0-9.]/g, '')) || 0 : 'No Result';
                        varProductRating = result.rating ? parseFloat(result.rating.replace(/[^0-9.]/g, '')) || 0 : 'No Result';

                        if (result.price && result.stock == 0) {
                            const priceValue = result.price.match(/[\d,]+(?:\.\d+)?/)?.[0] || '';
                            const newPrice = parseFloat(priceValue.replace(/,/g, ''));
                            if (newPrice > 0) {
                                varProductPrice = newPrice;
                                varProductStock = 'In stock';
                            } else {
                                varProductStock = 'Out Of Stock';
                            }
                        } else {
                            varProductStock = 'Out Of Stock';
                        }
                        scrapeStatus = 'completed';
                        successfulScrapes++;
                    } else {
                        failedScrapes++;
                    }
                }

                modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

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

                // Use safe MongoDB update with retry
                try {
                    await safeMongoUpdate(
                        {
                            collection: 'ept_product_details_new_amazon',
                            cmpid
                        },
                        {
                            [`${companyId}_product_id`]: productId,
                            [`${companyId}_product_code`]: productCode
                        },
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
                } catch (dbError) {
                    console.error('Database update error:', dbError.message);
                    // Continue even if DB update fails
                }

                const completedProgress = Math.round((currentProductNumber / ScrapingProductCount) * 100);

                sendEvent('product_complete', {
                    productNumber: currentProductNumber,
                    totalProducts: ScrapingProductCount,
                    processedProducts: currentProductNumber,
                    progress: completedProgress,
                    productId,
                    productCode,
                    status: scrapeStatus === 'completed' ? 'success' : 'pending',
                    data: {
                        product_ean_id: productId,
                        product_code: productCode,
                        product_price: varProductPrice,
                        product_stock: varProductStock,
                        modified_date: modifiedDate,
                        scrape_status: scrapeStatus
                    },
                    message: `Product ${currentProductNumber} completed`
                });

                if (!isSingleProduct) {
                    try {
                        await updateEndTimeInDb(
                            currentProductNumber,
                            'running',
                            cmpid,
                            companyId,
                            null,
                            cronName,
                            cronStartTime,
                            ScrapingProductCount
                        );
                    } catch (dbError) {
                        console.error('Error updating end time:', dbError.message);
                    }
                }

            } catch (error) {
                console.error(`Error scraping product ${productId}:`, error.message);
                failedScrapes++;

                sendEvent('product_error', {
                    productNumber: currentProductNumber,
                    totalProducts: ScrapingProductCount,
                    productId,
                    productCode,
                    progress: Math.round((currentProductNumber / ScrapingProductCount) * 100),
                    status: 'error',
                    message: error.message || 'Error scraping product'
                });

                try {
                    await safeMongoUpdate(
                        {
                            collection: 'ept_product_details_new_amazon',
                            cmpid
                        },
                        {
                            [`${companyId}_product_id`]: productId,
                            [`${companyId}_product_code`]: productCode
                        },
                        {
                            $set: {
                                product_scrape_status: 'pending',
                                modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time')
                            }
                        }
                    );
                } catch (dbError) {
                    console.error('Database update error:', dbError.message);
                }
            } finally {
                if (page && !isShuttingDown) {
                    returnPageToPool(page);
                }
            }

            await delay(CONFIG.DELAY_BETWEEN_PRODUCTS);
        }

        /*
        ========================================================
        PROCESS PRODUCTS
        ========================================================
        */

        // Process products one by one to avoid memory issues
        for (let i = 0; i < ArrGetProductInfo.length; i++) {
            if (clientDisconnected || isShuttingDown) {
                console.log('Stopping due to disconnect or shutdown');
                break;
            }

            await processSingleProduct(ArrGetProductInfo[i]);
            
            // Force garbage collection every 10 products
            if (i % 10 === 0 && global.gc) {
                global.gc();
                console.log(`Garbage collected at product ${i + 1}`);
            }
        }

        /*
        ========================================================
        FINAL CALCULATION
        ========================================================
        */

        const endTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
        const diffMs = endTime - startTime;
        const totalMins = +(diffMs / 60000).toFixed(2);

        if (!isSingleProduct) {
            try {
                await updateEndTimeInDb(
                    productCount,
                    'ending',
                    cmpid,
                    companyId,
                    totalMins,
                    cronName,
                    cronStartTime,
                    ScrapingProductCount
                );
            } catch (error) {
                console.error('Error updating final status:', error.message);
            }
        }

        sendEvent('complete', {
            status: true,
            message: 'Scraping completed',
            totalProducts: ScrapingProductCount,
            totalProcessed: productCount,
            successfulScrapes: successfulScrapes,
            failedScrapes: failedScrapes,
            progress: 100,
            totalMinutes: totalMins
        });

        res.end();

    } catch (error) {
        console.error('Amazon scraper error:', error);

        if (!res.writableEnded) {
            try {
                sendEvent('error', {
                    status: false,
                    message: error.message || 'Amazon scraping failed'
                });
                res.end();
            } catch (e) {
                console.error('Error sending error event:', e);
            }
        }
    } finally {
        await gracefulShutdown();
    }
}

module.exports = {
    amazonScraper
};