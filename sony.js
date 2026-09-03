const puppeteer = require('puppeteer');
const {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb
} = require('./utils/cronTime');

const { updatePriceChangeData } = require('./utils/priceChange');

const {
    executeMongoFind,
    executeMongoCount,
    executeMongoUpdate
} = require('./mongo');

const cronName = 'sony';

// Enhanced Configuration constants
const CONFIG = {
    PAGE_TIMEOUT: 30000,
    DELAY_BETWEEN_PRODUCTS: 300,
    MONGO_RETRY_DELAY: 2000,
    MAX_MONGO_RETRIES: 3,
    MAX_PRODUCT_RETRIES: 3,
    BROWSER_RESTART_AFTER: 80, // Restart browser after 80 products to prevent memory leaks
    MAX_CONCURRENT_PAGES: 3,
    MEMORY_THRESHOLD: 400 * 1024 * 1024, // 400MB
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
        '--js-flags=--max-old-space-size=2048',
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
        '--max_old_space_size=2048',
        '--disable-dev-shm-usage',
        '--single-process', // Use single process to reduce memory
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-jpeg-decoding',
        '--disable-accelerated-mjpeg-decode',
        '--disable-accelerated-video-decode'
    ]
};

async function sonyScraper(req, res) {

    const delay = (ms) =>
        new Promise(resolve => setTimeout(resolve, ms));

    let browser;
    let isShuttingDown = false;
    let productsProcessed = 0;
    let browserRestartCount = 0;

    // Memory monitoring
    const memoryMonitor = setInterval(() => {
        const used = process.memoryUsage();
        const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
        console.log(`[Memory] Heap: ${heapUsedMB}MB / ${heapTotalMB}MB, RSS: ${Math.round(used.rss / 1024 / 1024)}MB`);
        
        if (used.heapUsed > CONFIG.MEMORY_THRESHOLD) {
            console.log('⚠️ Memory threshold exceeded, forcing garbage collection');
            if (global.gc) {
                global.gc();
            }
        }
    }, 30000);

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
    BROWSER MANAGEMENT WITH RESTART
    ============================================================
    */

    const launchBrowser = async () => {
        console.log(`🚀 Launching browser (Restart #${browserRestartCount})...`);
        
        const newBrowser = await puppeteer.launch({
            headless: 'new', // Use new headless mode which is more memory efficient
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

        // Clear browser context for fresh start
        const context = newBrowser.defaultBrowserContext();
        await context.clearPermissionOverrides();
        
        return newBrowser;
    };

    const restartBrowser = async () => {

        console.log('🔄 Restarting browser to free memory...');
        browserRestartCount++;
        
        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                console.error('Error closing browser:', error);
            }
        }
        
        browser = await launchBrowser();    
        productsProcessed = 0;
        
        // Force garbage collection
        if (global.gc) {
            global.gc();
        }
        
        console.log(`✅ Browser restarted successfully (Restart #${browserRestartCount})`);
    };

    /*
    ============================================================
    CREATE NEW PAGE WITH OPTIMIZED SETTINGS
    ============================================================
    */
    
    const createNewPage = async () => {
        const newPage = await browser.newPage();
        
        // Optimize page settings - LESS BLOCKING to avoid timeouts
        await newPage.setRequestInterception(true);
        
        // Block only heavy resources
        newPage.on('request', (req) => {
            const resourceType = req.resourceType();
            // Only block heavy resources, allow critical ones
            if (['image', 'font', 'media'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        await newPage.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        
        await newPage.setViewport({
            width: 1366,
            height: 768
        });
        
        // Set shorter timeouts
        newPage.setDefaultTimeout(CONFIG.PAGE_TIMEOUT);
        newPage.setDefaultNavigationTimeout(CONFIG.PAGE_TIMEOUT);
        
        // Disable unnecessary features
        await newPage.evaluateOnNewDocument(() => {
            // Disable animations
            const style = document.createElement('style');
            style.textContent = `
                * {
                    animation-duration: 0s !important;
                    transition-duration: 0s !important;
                }
            `;
            document.head.appendChild(style);
        });
        
        return newPage;
    };

    /*
    ============================================================
    CLOSE PAGE WITH CLEANUP
    ============================================================
    */
    
    const closePage = async (page) => {
        if (page && !page.isClosed()) {
            try {
                // Clear all event listeners
                page.removeAllListeners();
                
                // Clear cookies
                const cookies = await page.cookies();
                if (cookies.length > 0) {
                    await page.deleteCookie(...cookies);
                }
                
                // Close page
                await page.close({ runBeforeUnload: true });
                
                console.log('✅ Page closed and cleaned up');
            } catch (error) {
                console.error('Error closing page:', error.message);
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
        console.log('Sony client disconnected');
        clearInterval(memoryMonitor);
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
        clearInterval(memoryMonitor);

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
        message: 'Sony scraping started',
        cmpid,
        companyId,
        isSingleProduct
    });

    try {
        sendEvent('step', {
            step: 'browser',
            status: 'running',
            message: 'Launching browser...'
        });

        browser = await launchBrowser();

        sendEvent('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching Sony products...'
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
                    collection: 'ept_product_details_new_sony',
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

        
        /*
        ========================================================
        OPTIMIZED NAVIGATION WITH RETRY
        ========================================================
        */

        async function navigateToPage(page, url, retries = 3) {
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    console.log(`🌐 Navigation attempt ${attempt} for ${url.substring(0, 50)}...`);
                    
                    await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 15000
                    });
                    
                    // Check if page loaded successfully
                    const title = await page.title().catch(() => '');
                    if (title && !title.includes('Robot') && !title.includes('Sorry')) {
                        console.log(`✅ Page loaded successfully (attempt ${attempt})`);
                        return true;
                    }
                    
                    throw new Error('Page loaded but appears to be blocked or empty');
                    
                } catch (error) {
                    console.log(`Navigation attempt ${attempt} failed:`, error.message);
                    
                    if (attempt === retries) {
                        return false;
                    }
                    
                    // Exponential backoff
                    const waitTime = Math.pow(2, attempt) * 2000;
                    console.log(`Waiting ${waitTime}ms before retry...`);
                    await delay(waitTime);
                    
                    // Refresh page state
                    try {
                        await page.reload({ timeout: 10000 });
                    } catch (e) {}
                }
            }
            return false;
        }

        /*
        ========================================================
        PROCESS SINGLE PRODUCT WITH RETRY
        ========================================================
        */
        
        async function processSingleProduct(product, retryCount = 0) {
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

            if (!hostname.includes('shopatsc')) {
                sendEvent('product_error', {
                    productId,
                    productCode,
                    status: 'error',
                    message: 'Only Sony URLs supported'
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
                retryCount: retryCount,
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
                    message: 'Opening Sony product page...'
                });

                // Create a new page for this product
                page = await createNewPage();

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
                const productTitleExists = await page.waitForSelector('div.product-single__meta h2.product-single__title', { 
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

                    // Extract data with multiple selector strategies
                    const result = await page.evaluate(() => {

                        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                        let productData = null;
                        let reviewData = null;

                        scripts.forEach(script => {
                            try {
                                const json = JSON.parse(script.textContent);

                                if (json['@type'] === 'Product') {
                                    if (json.offers) {
                                        productData = json;
                                    }
                                    if (json.aggregateRating) {
                                        reviewData = json.aggregateRating;
                                    }
                                }
                            } catch (e) {}
                        });

                        if (!productData) {
                            return null;
                        }

                        // Handle both single offer and array of offers
                        let offers = productData.offers;
                        if (offers && !Array.isArray(offers)) {
                            offers = [offers];
                        }

                        return {
                            price: offers?.[0]?.price || '',
                            availability: offers?.[0]?.availability || '',
                            image: productData.image?.[0] || productData.image || '',
                            review: reviewData?.reviewCount || 0,
                            rating: reviewData?.ratingValue || 0
                        };
                    });

                    if (result !== null) {

                        const status = (result.availability || '').toLowerCase().trim();

                        varProductImage = result.image || 'No Result';
                        varProductReview = result.review || 'No Result';
                        varProductRating = result.rating || 'No Result';

                        const cleanedPrice = result.price || '';

                        // Check availability
                        if ((status.includes('instock') || status.includes('in stock')) && (cleanedPrice > 0)) {
                            varProductPrice = parseFloat(cleanedPrice);
                            varProductStock = 'In stock';
                        } else if (status.includes('outofstock') || status.includes('out of stock') || status.includes('currently unavailable')) {
                            varProductStock = 'Out Of Stock';
                        } else {
                            // If availability status is unclear, check if price exists
                            if (cleanedPrice > 0) {
                                varProductPrice = parseFloat(cleanedPrice);
                                varProductStock = 'In stock';
                            } else {
                                varProductStock = 'Out Of Stock';
                            }
                        }
                        scrapeStatus = 'completed';
                        successfulScrapes++;

                    } else {
                        failedScrapes++;
                        throw new Error('Failed to extract product data');
                    }
                }

                modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

                // Update price change data
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

                // Update database
                try {
                    await safeMongoUpdate(
                        {
                            collection: 'ept_product_details_new_sony',
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
                                product_scrape_status: scrapeStatus,
                                last_scrape_attempt: getCurrentIndTimeInfo('India_Railway_Date_Time')
                            }
                        }
                    );
                } catch (dbError) {
                    console.error('Database update error:', dbError.message);
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
                
                // Retry logic
                if (retryCount < CONFIG.MAX_PRODUCT_RETRIES) {
                    console.log(`🔄 Retrying product ${productId}, attempt ${retryCount + 1} of ${CONFIG.MAX_PRODUCT_RETRIES}`);
                    await delay(5000 * (retryCount + 1)); // Increasing delay
                    
                    // Close current page if exists
                    if (page) {
                        await closePage(page);
                    }
                    
                    // Recreate page for retry
                    return await processSingleProduct(product, retryCount + 1);
                }
                
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
                            collection: 'ept_product_details_new_sony',
                            cmpid
                        },
                        {
                            [`${companyId}_product_id`]: productId,
                            [`${companyId}_product_code`]: productCode
                        },
                        {
                            $set: {
                                product_scrape_status: 'pending',
                                modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time'),
                                last_scrape_attempt: getCurrentIndTimeInfo('India_Railway_Date_Time')
                            }
                        }
                    );
                } catch (dbError) {
                    console.error('Database update error:', dbError.message);
                }
            } finally {
                // Close the page after each product
                if (page) {
                    await closePage(page);
                }
            }

            await delay(CONFIG.DELAY_BETWEEN_PRODUCTS);
        }

        /*
        ========================================================
        PROCESS PRODUCTS WITH BROWSER RESTART
        ========================================================
        */

        for (let i = 0; i < ArrGetProductInfo.length; i++) {
            if (clientDisconnected || isShuttingDown) {
                console.log('Stopping due to disconnect or shutdown');
                break;
            }

            // Check if browser restart is needed
            if (productsProcessed > 0 && productsProcessed % CONFIG.BROWSER_RESTART_AFTER === 0) {
                console.log(`⚠️ Processed ${productsProcessed} products since last browser restart`);
                await restartBrowser(true);
            }

            await processSingleProduct(ArrGetProductInfo[i]);
            productsProcessed++;
            
            // Force garbage collection every 5 products
            if (i % 5 === 0 && global.gc) {
                global.gc();
            }
            
            // Log progress every 50 products
            if (i % 50 === 0 && i > 0) {
                console.log(`📊 Progress: ${i + 1}/${ScrapingProductCount} products processed (${Math.round((i + 1) / ScrapingProductCount * 100)}%)`);
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
            totalMinutes: totalMins,
            browserRestarts: browserRestartCount
        });

        res.end();

    } catch (error) {
        console.error('Sony scraper error:', error);

        if (!res.writableEnded) {
            try {
                sendEvent('error', {
                    status: false,
                    message: error.message || 'Sony scraping failed'
                });
                res.end();
            } catch (e) {
                console.error('Error sending error event:', e);
            }
        }
    } finally {
        clearInterval(memoryMonitor);
        await gracefulShutdown();
    }
}

module.exports = {
    sonyScraper
};