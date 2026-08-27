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
    executeMongoCount,
    executeMongoUpdate
} = require('./mongo');

const cronName = 'vijaysales';

// Configuration constants
const CONFIG = {
    MAX_CONCURRENT_PAGES: 2,
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

async function vijaysalesScraper(req, res) {

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
    GRACEFUL SHUTDOWN
    ============================================================
    */

    const gracefulShutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        
        console.log('Starting graceful shutdown...');
        
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

    const isSingleProduct = !!(ean && itemcode);

    /*
    ============================================================
    SSE HEADERS
    ============================================================
    */

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    /*
    ============================================================
    CLIENT DISCONNECT HANDLING
    ============================================================
    */

    let clientDisconnected = false;

    req.on('close', () => {
        clientDisconnected = true;
        console.log('Vijay Sales client disconnected');
    });

    /*
    ============================================================
    INITIAL RESPONSE
    ============================================================
    */

    sendEvent('start', {
        status: true,
        message: 'Vijay Sales scraping started',
        cmpid,
        companyId,
        isSingleProduct
    });

    try {
        /*
        ========================================================
        LAUNCH BROWSER
        ========================================================
        */

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

        /*
        ========================================================
        GET PRODUCTS
        ========================================================
        */

        sendEvent('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching Vijay Sales products...'
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

        let products;
        try {
            products = await safeMongoFind(
                {
                    collection: 'ept_product_details_new_vijaysales',
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

        /*
        ========================================================
        GET EXISTING PRODUCTS
        ========================================================
        */

        let existingProducts;
        try {
            existingProducts = await safeMongoFind(
                {
                    collection: 'ept_product_details_new',
                    cmpid
                },
                {
                    status: 'active',
                    ean_product_data_details_scrap_status: 'completed'
                },
                {
                    _id: 0,
                    product_ean_id: 1,
                    product_code: 1
                }
            );
        } catch (error) {
            console.error('Failed to fetch existing products:', error);
            existingProducts = [];
        }

        const productMap = new Set();
        existingProducts.forEach((row) => {
            productMap.add(`${row.product_ean_id}_${row.product_code}`);
        });

        // Filter matching products - only vijaysales.com URLs
        const ArrGetProductInfo = products.filter((arrTmp) => {
            const key = `${arrTmp[`${companyId}_product_id`]}_${arrTmp[`${companyId}_product_code`]}`;
            return productMap.has(key) && 
                   arrTmp['product_url'] && 
                   arrTmp['product_url'].includes('https://www.vijaysales.com/');
        });

        // Clear arrays to free memory
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

        /*
        ========================================================
        SCRAPING INITIALIZATION
        ========================================================
        */

        let productCount = 0;
        let successfulScrapes = 0;
        let failedScrapes = 0;
        let inStockCount = 0;
        let outOfStockCount = 0;
        let noResultCount = 0;

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

        /*
        ========================================================
        PINCODE SETUP
        ========================================================
        */

        let pincode = await getStorePincode(companyId);
        if (pincode === null) {
            pincode = req.query.pincode || '600008';
        }

        console.log('Using pincode:', pincode);

        /*
        ========================================================
        OPTIMIZED NAVIGATION
        ========================================================
        */

        async function navigateToPage(page, url) {
            try {
                // Strategy 1: Try with domcontentloaded first
                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                });
                return true;
            } catch (error) {
                console.log('DOMContentLoaded timeout, trying load...');
                
                try {
                    // Strategy 2: Try with load event
                    await page.goto(url, {
                        waitUntil: 'load',
                        timeout: 15000
                    });
                    return true;
                } catch (error2) {
                    console.log('Load timeout, trying networkidle0...');
                    
                    try {
                        // Strategy 3: Try with networkidle0
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

            if (!hostname.includes('vijaysales')) {
                sendEvent('product_error', {
                    productId,
                    productCode,
                    status: 'error',
                    message: 'Only Vijay Sales URLs supported'
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
                    message: 'Opening Vijay Sales product page...'
                });

                // Get page from pool
                page = await getPageFromPool();

                // Use optimized navigation
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
                    message: 'Vijay Sales page loaded'
                });

                /*
                =================================================
                PRODUCT PAGE CHECK
                =================================================
                */

                const productPageExists = await page.waitForSelector('.product', { 
                    timeout: 5000 
                }).catch(() => null);

                if (!productPageExists) {
                    sendEvent('product_step', {
                        productNumber: currentProductNumber,
                        productId,
                        productCode,
                        step: 'product_page',
                        status: 'failed',
                        message: 'Product page not found'
                    });
                    failedScrapes++;
                } else {
                    /*
                    =============================================
                    EXTRACT PRODUCT DATA
                    =============================================
                    */

                    sendEvent('product_step', {
                        productNumber: currentProductNumber,
                        productId,
                        productCode,
                        step: 'extracting',
                        status: 'running',
                        message: 'Extracting product information...'
                    });

                    const result = await page.evaluate(async ({ productUrl, pincode }) => {

                        const getText = (selector) => {
                            const el = document.querySelector(selector);
                            return el ? el.textContent.trim() : '';
                        };

                        const getAttr = (selector, attr) => {
                            const el = document.querySelector(selector);
                            return el ? el.getAttribute(attr) : '';
                        };

                        let vanNo = null;
                        let availablestatus = "outofstock";
                        let availabilityError = "";

                        const match = productUrl.match(/\/p\/(?:P\d+\/)?(\d+)/);

                        if (match) {
                            vanNo = match[1];
                        }

                        if (vanNo && pincode) {
                            try {
                                const res = await fetch(
                                    `https://oms.vijaysales.systems/v1/servicability?pincode=${pincode}&vanNo=${vanNo}&storeList=true`
                                );

                                if (res.ok) {
                                    const data = await res.json();

                                    if (data?.data?.[vanNo]?.isServiceable === true) {
                                        availablestatus = "instock";
                                    } else {
                                        availabilityError = "Product is not serviceable for this pincode";
                                    }
                                } else {
                                    availabilityError = `Serviceability API failed with status ${res.status}`;
                                }
                            } catch (error) {
                                availabilityError = "Unable to check product serviceability";
                            }
                        } else {
                            if (!vanNo && !pincode) {
                                availabilityError = "Van number and pincode are missing";
                            } else if (!vanNo) {
                                availabilityError = "Van number is missing";
                            } else if (!pincode) {
                                availabilityError = "Pincode is missing";
                            }
                        }

                        const reviewText = getText('.product__title--stats') || '';
                        const rating = parseFloat(reviewText.match(/^\d+(\.\d+)?/)?.[0]) || 0;
                        const review = parseInt(reviewText.match(/\((\d+)\s*Ratings/i)?.[1]) || 0;

                        return {
                            price: getText('div.product__price--deatils div.product__price--vsp-wrap p.product__price--vsp span') || '',
                            availability: availablestatus,
                            availabilityError: availabilityError,
                            vanNo: vanNo,
                            pincode: pincode,
                            image: getAttr('.carousel__currentImage', 'src') || '',
                            review: review,
                            rating: rating
                        };

                    }, {
                        productUrl,
                        pincode
                    });

                    if (result !== null) {
                        const status = (result.availability || '').toLowerCase().trim();

                        varProductImage = result.image || 'No Result';
                        varProductReview = result.review != null ? Number(result.review) : 'No Result';
                        varProductRating = result.rating != null ? Number(result.rating) : 'No Result';

                        if (status.includes('instock')) {
                            const cleanedPrice = (result.price || '').replace(/[^0-9.]/g, '');
                            varProductPrice = parseFloat(cleanedPrice) || 'No Result';
                            varProductStock = 'In stock';
                            inStockCount++;
                        } else if (status.includes('outofstock') || status.includes('currently unavailable')) {
                            varProductStock = 'Out Of Stock';
                            outOfStockCount++;
                        } else {
                            varProductStock = 'No Result';
                            noResultCount++;
                        }

                        scrapeStatus = 'completed';
                        successfulScrapes++;
                    } else {
                        failedScrapes++;
                    }

                    sendEvent('product_step', {
                        productNumber: currentProductNumber,
                        productId,
                        productCode,
                        step: 'extracting',
                        status: scrapeStatus === 'completed' ? 'completed' : 'failed',
                        message: scrapeStatus === 'completed' 
                            ? 'Product information extracted' 
                            : 'Product information not found'
                    });
                }

                /*
                =================================================
                MODIFIED DATE
                =================================================
                */

                modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

                /*
                =================================================
                PRICE CHANGE
                =================================================
                */

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

                sendEvent('product_step', {
                    productNumber: currentProductNumber,
                    productId,
                    productCode,
                    step: 'database',
                    status: 'running',
                    message: 'Updating database...'
                });

                /*
                =================================================
                MONGO UPDATE
                =================================================
                */

                try {
                    await safeMongoUpdate(
                        {
                            collection: 'ept_product_details_new_vijaysales',
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
                }

                /*
                =================================================
                PRODUCT COMPLETE
                =================================================
                */

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

                /*
                =================================================
                UPDATE CRON PROGRESS
                =================================================
                */

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
                    } catch (error) {
                        console.error('Error updating end time:', error.message);
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
                            collection: 'ept_product_details_new_vijaysales',
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

        /*
        ========================================================
        FINAL SSE RESPONSE - Without scrapedData
        ========================================================
        */

        sendEvent('complete', {
            status: true,
            message: 'Scraping completed',
            totalProducts: ScrapingProductCount,
            totalProcessed: productCount,
            successfulScrapes: successfulScrapes,
            failedScrapes: failedScrapes,
            progress: 100,
            totalMinutes: totalMins,
            summary: {
                inStockCount: inStockCount,
                outOfStockCount: outOfStockCount,
                noResultCount: noResultCount
            }
        });

        res.end();

    } catch (error) {
        console.error('Vijay Sales scraper error:', error);

        if (!res.writableEnded) {
            try {
                sendEvent('error', {
                    status: false,
                    message: error.message || 'Vijay Sales scraping failed'
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
    vijaysalesScraper
};