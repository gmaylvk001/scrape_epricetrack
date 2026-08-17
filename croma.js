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

const cronName = 'croma';

async function cromaScraper(req, res) {

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
            'Croma client disconnected'
        );
    });


    /*
    ============================================================
    INITIAL RESPONSE
    ============================================================
    */

    sendEvent('start', {
        status: true,
        message: 'Croma scraping started',
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
            message: 'Fetching Croma products...'
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
        GET CROMA PRODUCTS
        ========================================================
        */

        const products = await executeMongoFind(

            {
                collection:
                    'ept_product_details_new_croma',

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
                    },
                    {
                        ean_product_data_details_scrap_status: 'completed'
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


            if (
                productMap.has(key) &&
                arrTmp['product_url'].includes('https://www.croma.com/')
            ) {

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


        /*
        ========================================================
        SET PINCODE
        ========================================================
        */

        sendEvent('step', {
            step: 'pincode',
            status: 'running',
            message: 'Setting pincode for Croma...'
        });


        try {

            const productUrltest = "https://www.croma.com/";

            await page.goto(productUrltest, {
                waitUntil: 'networkidle2',
                timeout: 50000
            });

            await delay(3000);

            if (await page.$('.pinElem') === null) {

                console.log('Croma pincode popup not found, continuing...');

                sendEvent('step', {
                    step: 'pincode',
                    status: 'skipped',
                    message: 'Pincode popup not found, continuing...'
                });

            } else {

                await page.waitForSelector('.pinElem', {
                    visible: true,
                    timeout: 15000
                });

                const input = await page.$('.pinElem');

                // Select existing pincode
                await input.click({ clickCount: 3 });

                await page.keyboard.down('Control');
                await page.keyboard.press('A');
                await page.keyboard.up('Control');

                await page.keyboard.press('Backspace');

                // Enter new pincode
                await input.type('600001', {
                    delay: 100
                });

                // Trigger input events
                await input.evaluate(el => {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                });

                await delay(1000);

                // Click Continue
                await page.click('#apply-pincode-btn');

                // Wait until popup is hidden
                await page.waitForFunction(() => {
                    const dialog = document.querySelector('.MuiDialog-root');

                    if (!dialog) return true;

                    return getComputedStyle(dialog).display === 'none';
                }, {
                    timeout: 30000
                });

                // Wait for page/network update
                await page.waitForNetworkIdle({
                    idleTime: 2000,
                    timeout: 50000
                });

                await delay(2000);

                sendEvent('step', {
                    step: 'pincode',
                    status: 'completed',
                    message: 'Pincode set successfully'
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
            CROMA URL CHECK
            ====================================================
            */

            if (!hostname.includes('croma')) {

                sendEvent('product_error', {

                    productId,

                    productCode,

                    status: 'error',

                    message:
                        'Only Croma URLs supported'
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
                        'Opening Croma product page...'
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
                        'Croma page loaded'
                });


                /*
                =================================================
                PRODUCT TITLE CHECK
                =================================================
                */

                const productTitleExists =
                    await page.$('.pd-title-normal');


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


                    await page.waitForSelector(
                        'script[type="application/ld+json"], [class*="pd-title-normal"], .pd-title-normal',
                        { timeout: 30000 }
                    );


                    const result = await page.evaluate(() => {

                        const productData = [...document.querySelectorAll('script[type="application/ld+json"]')]
                            .map(script => {
                                let text = script.textContent.trim();
                                try {
                                    return JSON.parse(text);
                                } catch (e) {
                                    try {
                                        // Fix invalid escape sequences
                                        text = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
                                        // Fix description field (raw newlines -> \n)
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
                                        // Remove extra closing braces at the end (if any)
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
                                    } catch (err) {
                                        console.log("JSON-LD Parse Error:", err.message);
                                    }
                                    return null;
                                }
                            }).find(item => item?.["@type"] === "Product");

                        const ProductPrice = document.querySelector('#pdp-product-price')?.textContent?.trim();
                        const StockStatus = ((document.querySelector('span.not-available-color')) || (document.querySelector('span.approvalStatus-span-message'))) ? 'outofstock' : 'instock';

                        return {
                            price: ProductPrice || '',
                            image: productData?.image?.[0] || '',
                            availability: StockStatus,
                            review: productData?.aggregateRating?.ratingCount || '0',
                            rating: productData?.aggregateRating?.ratingValue || '0'
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

                        const status =
                            (result.availability || '')
                                .toLowerCase()
                                .trim();


                        varProductReview =
                            parseFloat(result.review) || 0;


                        varProductRating =
                            (Math.round(parseFloat(result.rating) * 10) / 10) || 0;


                        varProductImage =
                            result.image ||
                            'No Result';


                        const cleanedPrice =
                            (result.price || '')
                                .replace(/[^0-9.]/g, '');


                        scrapeStatus =
                            'completed';


                        /*
                        =========================================
                        IN STOCK
                        =========================================
                        */

                        if (
                            (status === 'instock') &&
                            (cleanedPrice > 0)
                        ) {

                            varProductPrice =
                                parseFloat(cleanedPrice) ||
                                'No Result';


                            varProductStock =
                                'In stock';

                        }

                        /*
                        =========================================
                        OUT OF STOCK
                        =========================================
                        */

                        else if (

                            status.includes(
                                'outofstock'
                            ) ||

                            status.includes(
                                'currently unavailable'
                            )

                        ) {

                            varProductStock =
                                'Out Of Stock';
                        }
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
                            'ept_product_details_new_croma',

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
                                'ept_product_details_new_croma',

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
            'Croma scraper error:',
            error
        );


        if (!res.writableEnded) {

            sendEvent('error', {

                status: false,

                message:
                    error.message
                    || 'Croma scraping failed'
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
    cromaScraper
};