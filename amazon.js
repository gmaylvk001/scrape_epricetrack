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

const cronName = 'amazon';

async function amazonScraper(req, res) {

    const delay = (ms) =>
        new Promise(resolve => setTimeout(resolve, ms));

    let browser;

    /*
    ============================================================
    SSE RESPONSE HELPERS
    ============================================================
    */

    const sendEvent = (event, data) => {

        if (res.writableEnded) {
            return;
        }

        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);

        // Make sure data is flushed
        if (typeof res.flush === 'function') {
            res.flush();
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

    // Important for nginx / reverse proxy buffering
    res.setHeader('X-Accel-Buffering', 'no');

    // CORS
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

        console.log(
            'Amazon client disconnected'
        );
    });


    /*
    ============================================================
    INITIAL RESPONSE
    ============================================================
    */

    sendEvent('start', {
        status: true,
        message: 'Amazon scraping started',
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

            executablePath:
                process.env.PUPPETEER_EXECUTABLE_PATH || undefined,

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


        const page = await browser.newPage();


        /*
        ========================================================
        USER AGENT
        ========================================================
        */

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        );


        /*
        ========================================================
        GET PRODUCTS
        ========================================================
        */

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


        /*
        ========================================================
        SINGLE PRODUCT FILTER
        ========================================================
        */

        if (isSingleProduct) {

            filter[`${companyId}_product_id`] = ean;

            filter[`${companyId}_product_code`] = itemcode;
        }


        /*
        ========================================================
        GET AMAZON PRODUCTS
        ========================================================
        */

        const products = await executeMongoFind(

            {
                collection:
                    'ept_product_details_new_amazon',

                cmpid
            },

            filter,

            {
                _id: 0
            }
        );


        if (!products || products.length === 0) {

            sendEvent('complete', {

                status: true,

                message:
                    'Competitor products not found',

                totalProcessed: 0,

                data: []
            });

            res.end();

            return;
        }


        /*
        ========================================================
        GET EXISTING PRODUCTS
        ========================================================
        */

        const existingProducts = await executeMongoFind(

            {
                collection:
                    'ept_product_details_new',

                cmpid
            },

            {
                $and: [
                    {
                        status: 'active'
                    }
                ]
            },

            {
                _id: 0,

                product_ean_id: 1,

                product_code: 1
            }
        );


        /*
        ========================================================
        CREATE PRODUCT MAP
        ========================================================
        */

        const productMap = new Set();


        existingProducts.forEach((row) => {

            const key =
                `${row.product_ean_id}_${row.product_code}`;

            productMap.add(key);
        });


        /*
        ========================================================
        FILTER MATCHING PRODUCTS
        ========================================================
        */

        const ArrGetProductInfo = [];


        products.forEach((arrTmp) => {

            const key =
                `${arrTmp[`${companyId}_product_id`]}_${arrTmp[`${companyId}_product_code`]}`;


            if (productMap.has(key)) {

                ArrGetProductInfo.push(arrTmp);
            }
        });


        if (ArrGetProductInfo.length === 0) {

            sendEvent('complete', {

                status: true,

                message:
                    'Active products not found',

                totalProcessed: 0,

                data: []
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

        const ScrapingProductCount =
            ArrGetProductInfo.length;


        const startTime =
            new Date(
                `${getCurrentIndTimeInfo(
                    'India_Railway_Date_Only'
                )}T${getCurrentIndTimeInfo(
                    'India_Railway_Time'
                )}`
            );


        const cronStartTime =
            getCurrentIndTimeInfo();


        /*
        ========================================================
        UPDATE START TIME
        ========================================================
        */

        if (!isSingleProduct) {

            await updateStartTimeInDb(

                cmpid,

                companyId,

                cronName,

                ScrapingProductCount
            );
        }


        /*
        ========================================================
        SEND PRODUCT COUNT
        ========================================================
        */

        sendEvent('progress', {

            status: 'running',

            totalProducts:
                ScrapingProductCount,

            processedProducts: 0,

            progress: 0,

            message:
                `${ScrapingProductCount} products found`
        });


        const scrapedData = [];


        /*
        ========================================================
        PRODUCT LOOP
        ========================================================
        */

        for (
            const product of ArrGetProductInfo
        ) {


            /*
            ====================================================
            CHECK CLIENT CONNECTION
            ====================================================
            */

            if (clientDisconnected) {

                console.log(
                    'Client disconnected. Stopping stream.'
                );

                break;
            }


            const productUrl =
                product.product_url;


            const productId =
                product[
                    `${companyId}_product_id`
                ];


            const productCode =
                product[
                    `${companyId}_product_code`
                ];


            /*
            ====================================================
            URL VALIDATION
            ====================================================
            */

            let hostname;

            try {

                hostname =
                    new URL(productUrl).hostname;

            } catch (error) {

                console.error(
                    'Invalid product URL:',
                    productUrl
                );

                sendEvent('product_error', {

                    productId,

                    productCode,

                    status: 'error',

                    message:
                        'Invalid product URL'
                });

                continue;
            }


            /*
            ====================================================
            AMAZON URL CHECK
            ====================================================
            */

            if (!hostname.includes('amazon')) {

                sendEvent('product_error', {

                    productId,

                    productCode,

                    status: 'error',

                    message:
                        'Only Amazon URLs supported'
                });

                continue;
            }


            /*
            ====================================================
            PRODUCT START
            ====================================================
            */

            productCount++;

            const currentProductNumber =
                productCount;


            const currentProgress =
                Math.round(
                    (
                        (
                            currentProductNumber - 1
                        ) /
                        ScrapingProductCount
                    ) * 100
                );


            sendEvent('product_start', {

                productNumber:
                    currentProductNumber,

                totalProducts:
                    ScrapingProductCount,

                progress:
                    currentProgress,

                productId,

                productCode,

                productUrl,

                status: 'running',

                message:
                    `Scraping product ${currentProductNumber} of ${ScrapingProductCount}`
            });


            let varProductPrice =
                'No Result';

            let varProductStock =
                'No Result';

            let varProductImage =
                'No Result';

            let varProductReview =
                'No Result';

            let varProductRating =
                'No Result';

            let scrapeStatus =
                'pending';

            let modifiedDate;


            /*
            ====================================================
            PRODUCT SCRAPING
            ====================================================
            */

            try {

                sendEvent('product_step', {

                    productNumber:
                        currentProductNumber,

                    productId,

                    productCode,

                    step: 'page_loading',

                    status: 'running',

                    message:
                        'Opening Amazon product page...'
                });


                /*
                =================================================
                PAGE GOTO
                =================================================
                */

                await page.goto(productUrl, {

                    waitUntil:
                        'networkidle2',

                    timeout:
                        50000
                });


                sendEvent('product_step', {

                    productNumber:
                        currentProductNumber,

                    productId,

                    productCode,

                    step:
                        'page_loaded',

                    status:
                        'completed',

                    message:
                        'Amazon page loaded'
                });


                /*
                =================================================
                PRODUCT TITLE CHECK
                =================================================
                */

                const productTitleExists =
                    await page.$('#productTitle');


                if (!productTitleExists) {

                    varProductPrice =
                        'No Result';

                    varProductStock =
                        'No Result';

                    varProductImage =
                        'No Result';

                    varProductReview =
                        'No Result';

                    varProductRating =
                        'No Result';

                    scrapeStatus =
                        'pending';


                    sendEvent('product_step', {

                        productNumber:
                            currentProductNumber,

                        productId,

                        productCode,

                        step:
                            'product_title',

                        status:
                            'failed',

                        message:
                            'Product title not found'
                    });

                } else {


                    /*
                    =============================================
                    EXTRACT PRODUCT DATA
                    =============================================
                    */

                    sendEvent('product_step', {

                        productNumber:
                            currentProductNumber,

                        productId,

                        productCode,

                        step:
                            'extracting',

                        status:
                            'running',

                        message:
                            'Extracting product information...'
                    });


                    const result =
                        await page.evaluate(() => {

                            const getText = (selector) => {
                                const el = document.querySelector(selector);
                                return el ? el.textContent.trim() : '';
                            };

                            const getAttr = (selector, attr) => {
                                const el = document.querySelector(selector);
                                return el ? el.getAttribute(attr) : '';
                            };

                            return {
                                price: getText('#apex-pricetopay-accessibility-label'),
                                image: getAttr('#landingImage', 'src'),
                                review: getText('#acrCustomerReviewText') || 0,
                                rating: getText('.mvt-cm-cr-review-stars-mini-popover span') || 0
                            };
                        });


                    /*
                    =============================================
                    DEFAULT VALUES
                    =============================================
                    */

                    varProductPrice =
                        'No Result';

                    varProductStock =
                        'No Result';

                    varProductImage =
                        'No Result';

                    varProductReview =
                        'No Result';

                    varProductRating =
                        'No Result';

                    scrapeStatus =
                        'pending';


                    /*
                    =============================================
                    RESULT FOUND
                    =============================================
                    */

                    if (result !== null) {

                        varProductImage =
                            result.image ||
                            'No Result';


                        varProductReview =
                            result.review
                                ? parseFloat(result.review.replace(/[^0-9.]/g, '')) || 0
                                : 'No Result';


                        varProductRating =
                            result.rating
                                ? parseFloat(result.rating.replace(/[^0-9.]/g, '')) || 0
                                : 'No Result';


                        /*
                        =========================================
                        PROCESS PRICE
                        =========================================
                        */

                        if (result.price) {

                            const priceValue =
                                result.price.match(/[\d,]+(?:\.\d+)?/)?.[0] || '';

                            const newPrice =
                                parseFloat(priceValue.replace(/,/g, ''));

                            if (newPrice > 0) {

                                varProductPrice = newPrice;

                                varProductStock = 'In stock';

                            } else {

                                varProductStock = 'Out Of Stock';
                            }

                        } else {

                            varProductStock = 'Out Of Stock';
                        }


                        scrapeStatus =
                            'completed';
                    }


                    sendEvent('product_step', {

                        productNumber:
                            currentProductNumber,

                        productId,

                        productCode,

                        step:
                            'extracting',

                        status:
                            scrapeStatus === 'completed'
                                ? 'completed'
                                : 'failed',

                        message:
                            scrapeStatus === 'completed'
                                ? 'Product information extracted'
                                : 'Product information not found'
                    });
                }


                /*
                =================================================
                MODIFIED DATE
                =================================================
                */

                modifiedDate =
                    getCurrentIndTimeInfo(
                        'India_Railway_Date_Time'
                    );


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

                    productNumber:
                        currentProductNumber,

                    productId,

                    productCode,

                    step:
                        'database',

                    status:
                        'running',

                    message:
                        'Updating database...'
                });


                /*
                =================================================
                MONGO UPDATE
                =================================================
                */

                await executeMongoUpdate(

                    {
                        collection:
                            'ept_product_details_new_amazon',

                        cmpid
                    },

                    {
                        [`${companyId}_product_id`]:
                            productId,

                        [`${companyId}_product_code`]:
                            productCode
                    },

                    {
                        $set: {

                            product_price:
                                varProductPrice,

                            product_stock:
                                varProductStock,

                            product_image:
                                varProductImage,

                            product_review:
                                varProductReview,

                            product_rating:
                                varProductRating,

                            modified_date:
                                modifiedDate,

                            product_scrape_status:
                                scrapeStatus
                        }
                    }
                );


                /*
                =================================================
                PUSH RESULT
                =================================================
                */

                const productResult = {

                    product_ean_id:
                        productId,

                    product_code:
                        productCode,

                    product_price:
                        varProductPrice,

                    product_stock:
                        varProductStock,

                    modified_date:
                        modifiedDate,

                    scrape_status:
                        scrapeStatus
                };


                scrapedData.push(
                    productResult
                );


                /*
                =================================================
                PRODUCT COMPLETE
                =================================================
                */

                const completedProgress =
                    Math.round(
                        (
                            currentProductNumber /
                            ScrapingProductCount
                        ) * 100
                    );


                sendEvent('product_complete', {

                    productNumber:
                        currentProductNumber,

                    totalProducts:
                        ScrapingProductCount,

                    processedProducts:
                        currentProductNumber,

                    progress:
                        completedProgress,

                    productId,

                    productCode,

                    status:
                        scrapeStatus === 'completed'
                            ? 'success'
                            : 'pending',

                    data:
                        productResult,

                    message:
                        `Product ${currentProductNumber} completed`
                });


                /*
                =================================================
                UPDATE CRON PROGRESS
                =================================================
                */

                if (!isSingleProduct) {

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
                }


            } catch (error) {


                /*
                =================================================
                PRODUCT ERROR
                =================================================
                */

                console.error(
                    `Error scraping product ${productId}`
                );

                console.error(error);


                sendEvent('product_error', {

                    productNumber:
                        currentProductNumber,

                    totalProducts:
                        ScrapingProductCount,

                    productId,

                    productCode,

                    progress:
                        Math.round(
                            (
                                currentProductNumber /
                                ScrapingProductCount
                            ) * 100
                        ),

                    status:
                        'error',

                    message:
                        error.message
                        || 'Error scraping product'
                });


                /*
                =================================================
                UPDATE PRODUCT AS PENDING
                =================================================
                */

                try {

                    await executeMongoUpdate(

                        {
                            collection:
                                'ept_product_details_new_amazon',

                            cmpid
                        },

                        {
                            [`${companyId}_product_id`]:
                                productId,

                            [`${companyId}_product_code`]:
                                productCode
                        },

                        {
                            $set: {

                                product_scrape_status:
                                    'pending',

                                modified_date:
                                    getCurrentIndTimeInfo(
                                        'India_Railway_Date_Time'
                                    )
                            }
                        }
                    );

                } catch (dbError) {

                    console.error(
                        'Database update error:',
                        dbError
                    );
                }
            }


            /*
            ====================================================
            SMALL DELAY
            ====================================================
            */

            await delay(100);


        }


        /*
        ========================================================
        FINAL CALCULATION
        ========================================================
        */

        const endTime =
            new Date(
                `${getCurrentIndTimeInfo(
                    'India_Railway_Date_Only'
                )}T${getCurrentIndTimeInfo(
                    'India_Railway_Time'
                )}`
            );


        const diffMs =
            endTime - startTime;


        const totalMins =
            +(
                diffMs / 60000
            ).toFixed(2);


        /*
        ========================================================
        UPDATE FINAL STATUS
        ========================================================
        */

        if (!isSingleProduct) {

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
        }


        /*
        ========================================================
        FINAL SSE RESPONSE
        ========================================================
        */

        sendEvent('complete', {

            status: true,

            message:
                'Scraping completed',

            totalProducts:
                ScrapingProductCount,

            totalProcessed:
                productCount,

            progress: 100,

            totalMinutes:
                totalMins,

            data:
                scrapedData
        });


        /*
        ========================================================
        CLOSE STREAM
        ========================================================
        */

        res.end();


    } catch (error) {


        /*
        ========================================================
        MAIN ERROR
        ========================================================
        */

        console.error(
            'Amazon scraper error:',
            error
        );


        if (!res.writableEnded) {

            sendEvent('error', {

                status: false,

                message:
                    error.message
                    || 'Amazon scraping failed'
            });

            res.end();
        }


    } finally {


        /*
        ========================================================
        CLOSE BROWSER
        ========================================================
        */

        if (browser) {

            console.log(
                'Closing browser...'
            );

            try {

                await browser.close();

            } catch (error) {

                console.error(
                    'Browser close error:',
                    error
                );
            }
        }
    }
}


module.exports = {
    amazonScraper
};