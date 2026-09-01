const puppeteer = require('puppeteer');
const { getCurrentIndTimeInfo, updateStartTimeInDb, updateEndTimeInDb } = require('./utils/cronTime');
const { executeMongoFind, executeMongoCount, executeMongoUpdate } = require('./mongo');
const { updatePriceChangeData } = require('./utils/priceChange');

const cronName = 'poorvika';

async function poorvikaScraper(req, res) {

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    let browser;

    /*
    |--------------------------------------------------------------------------
    | SSE SETUP
    |--------------------------------------------------------------------------
    */

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (res.flushHeaders) {
        res.flushHeaders();
    }

    const sendSSE = (event, data) => {
        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (error) {
            console.error('SSE send error:', error.message);
        }
    };

    try {

        sendSSE('start', {
            status: true,
            message: 'Poorvika scraper started',
            cronName
        });

        /*
        |--------------------------------------------------------------------------
        | BROWSER
        |--------------------------------------------------------------------------
        */

        sendSSE('step', {
            status: true,
            step: 'browser_launch',
            message: 'Launching browser...'
        });

        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--no-first-run',
                '--no-default-browser-check'
            ]
        });

        sendSSE('step', {
            status: true,
            step: 'browser_ready',
            message: 'Browser launched successfully'
        });

        /*
            await page.authenticate({
                username: 'eqenhyym',
                password: 'qsfp3x1obv71'
            });
        */

        const cmpid = req.query.cmpid;

        if (!cmpid) {

            sendSSE('error', {
                status: false,
                message: 'cmpid is required'
            });

            return res.end();
        }

        const companyId = cmpid.replace('plm_user_info_', '');

        const ean = req.query.ean;
        const itemcode = req.query.itemcode;

        const filter = {
            status: 'active',
            product_scrape_status: { $in: ['pending', 'completed'] },
            product_url: { $nin: ['', null, 'No Result'] }
        };

        const isSingleProduct = !!(ean && itemcode);

        if (isSingleProduct) {
            filter[`${companyId}_product_id`] = ean;
            filter[`${companyId}_product_code`] = itemcode;
        }

        sendSSE('step', {
            status: true,
            step: 'fetch_products',
            message: 'Fetching Poorvika products...'
        });

        const products = await executeMongoFind(
            {
                collection: 'ept_product_details_new_poorvika',
                cmpid
            },
            filter,
            { _id: 0 }
        );

        if (products.length > 0) {

            sendSSE('step', {
                status: true,
                step: 'fetch_existing_products',
                message: 'Fetching existing products...'
            });

            const existingProducts = await executeMongoFind(
                {
                    collection: 'ept_product_details_new',
                    cmpid
                },
                {
                    $and: [
                        { status: 'active' },
                        { ean_product_data_details_scrap_status: 'completed' }
                    ]
                },
                { _id: 0, product_ean_id: 1, product_code: 1 }
            );

            const productMap = new Set();

            existingProducts.forEach((row) => {
                const key = `${row.product_ean_id}_${row.product_code}`;
                productMap.add(key);
            });

            // Filter matching products
            const ArrGetProductInfo = [];

            products.forEach((arrTmp) => {

                const key =
                    `${arrTmp[`${companyId}_product_id`]}_${arrTmp[`${companyId}_product_code`]}`;

                if (
                    productMap.has(key) &&
                    arrTmp['product_url'].includes('https://www.poorvika.com/')
                ) {
                    ArrGetProductInfo.push(arrTmp);
                }

            });

            if (ArrGetProductInfo.length > 0) {

                let productCount = 0;

                const startTime = new Date(
                    `${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`
                );

                const cronStartTime = getCurrentIndTimeInfo();

                const ScrapingProductCount = ArrGetProductInfo.length;

                if (!isSingleProduct) {

                    await updateStartTimeInDb(
                        cmpid,
                        companyId,
                        cronName,
                        ScrapingProductCount
                    );

                }

                const scrapedData = [];

                /*
                |--------------------------------------------------------------------------
                | TOTAL PRODUCT EVENT
                |--------------------------------------------------------------------------
                */

                sendSSE('step', {
                    status: true,
                    step: 'products_ready',
                    message: 'Products ready for scraping',
                    totalProducts: ScrapingProductCount,
                    isSingleProduct
                });

                /*
                |--------------------------------------------------------------------------
                | PRODUCT SCRAPING
                |--------------------------------------------------------------------------
                */

                for (const product of ArrGetProductInfo) {

                    const productUrl = product.product_url;
                    const hostname = new URL(productUrl).hostname;

                    if (!hostname.includes('poorvika')) {

                        sendSSE('error', {
                            status: false,
                            message: 'Only poorvika URLs supported',
                            productUrl
                        });

                        continue;
                    }

                    const currentProductNumber = productCount + 1;

                    sendSSE('product_start', {
                        status: true,
                        productNumber: currentProductNumber,
                        totalProducts: ScrapingProductCount,
                        progress: Number(
                            (((currentProductNumber - 1) / ScrapingProductCount) * 100).toFixed(2)
                        ),
                        productId: product[`${companyId}_product_id`],
                        productCode: product[`${companyId}_product_code`],
                        productUrl
                    });

                    let page = null;

                    try {

                        /*
                        |--------------------------------------------------------------------------
                        | CREATE NEW PAGE FOR ONLY THIS PRODUCT
                        |--------------------------------------------------------------------------
                        */

                        page = await browser.newPage();

                        await page.setUserAgent(
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
                        );

                        // Desktop viewport only
                        await page.setViewport({
                            width: 1366,
                            height: 768,
                            deviceScaleFactor: 1,
                            isMobile: false,
                            hasTouch: false
                        });

                        sendSSE('step', {
                            status: true,
                            step: 'page_created',
                            productNumber: currentProductNumber,
                            productId: product[`${companyId}_product_id`],
                            message: 'New page created for product'
                        });

                        /*
                        |--------------------------------------------------------------------------
                        | SCRAPE ONLY THIS PRODUCT
                        |--------------------------------------------------------------------------
                        */

                        await page.goto(productUrl, {
                            waitUntil: 'networkidle2',
                            timeout: 50000
                        });

                        let varProductPrice = 'No Result';
                        let varProductStock = 'No Result';
                        let varProductImage = 'No Result';
                        let varProductReview = 'No Result';
                        let varProductRating = 'No Result';
                        let scrapeStatus = 'pending';

                        const productContainer =
                            await page.$('.main-detail_product_container__bFKim');

                        if (!productContainer) {

                            console.log(
                                `Product container not found: ${product[`${companyId}_product_id`]}`
                            );

                        } else {

                            const result = await page.evaluate(() => {

                                const nextDataElement =
                                    document.querySelector('#__NEXT_DATA__');

                                if (!nextDataElement) {
                                    return null;
                                }

                                try {

                                    const productData =
                                        JSON.parse(nextDataElement.textContent);

                                    const pimData =
                                        productData?.props?.pageProps?.pimData;

                                    if (!pimData) {
                                        return null;
                                    }

                                    const image =
                                        pimData?.image?.url || '';

                                    const salePrice =
                                        pimData?.prices?.[0]?.sp?.[0]?.price || '';

                                    const review =
                                        pimData?.review_count ?? 0;

                                    const rating =
                                        pimData?.rating ?? 0;

                                    const availabilityElement =
                                        document.querySelector(
                                            '.style_text_stock__eeCR_'
                                        );

                                    const availabilityText =
                                        availabilityElement
                                            ? availabilityElement.textContent.trim()
                                            : '';

                                    let availabilityStatus = 'outofstock';

                                    if (
                                        availabilityText
                                            .toLowerCase()
                                            .includes('in stock')
                                    ) {
                                        availabilityStatus = 'instock';
                                    }

                                    return {
                                        price: salePrice,
                                        availability: availabilityStatus,
                                        image,
                                        review,
                                        rating
                                    };

                                } catch (error) {

                                    return null;

                                }

                            });

                            if (result) {

                                const status =
                                    (result.availability || '')
                                        .toLowerCase()
                                        .trim();

                                varProductImage =
                                    result.image || 'No Result';

                                varProductReview =
                                    result.review != null
                                        ? parseFloat(result.review) || 0
                                        : 0;

                                varProductRating =
                                    result.rating != null
                                        ? parseFloat(result.rating) || 0
                                        : 0;

                                if (status.includes('instock')) {

                                    const cleanedPrice =
                                        String(result.price || '')
                                            .replace(/[^0-9.]/g, '');

                                    varProductPrice =
                                        parseFloat(cleanedPrice) || 0;

                                    varProductStock = 'In stock';

                                } else {

                                    varProductStock = 'Out Of Stock';
                                }

                                scrapeStatus = 'completed';
                            }
                        }

                        const modifiedDate =
                            getCurrentIndTimeInfo('India_Railway_Date_Time');

                        /*
                        |--------------------------------------------------------------------------
                        | PRICE CHANGE
                        |--------------------------------------------------------------------------
                        */

                        await updatePriceChangeData(
                            scrapeStatus,
                            product.product_price,
                            varProductPrice,
                            product[`${companyId}_product_id`],
                            product[`${companyId}_product_code`],
                            cronName,
                            cmpid,
                            companyId
                        );

                        /*
                        |--------------------------------------------------------------------------
                        | MONGO UPDATE
                        |--------------------------------------------------------------------------
                        */

                        await executeMongoUpdate(
                            {
                                collection: 'ept_product_details_new_poorvika',
                                cmpid
                            },
                            {
                                [`${companyId}_product_id`]:
                                    product[`${companyId}_product_id`],

                                [`${companyId}_product_code`]:
                                    product[`${companyId}_product_code`]
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

                        scrapedData.push({
                            product_ean_id:
                                product[`${companyId}_product_id`],

                            product_code:
                                product[`${companyId}_product_code`],

                            product_price:
                                varProductPrice,

                            product_stock:
                                varProductStock,

                            modified_date:
                                modifiedDate
                        });

                        productCount++;

                        /*
                        |--------------------------------------------------------------------------
                        | CRON UPDATE
                        |--------------------------------------------------------------------------
                        */

                        if (!isSingleProduct) {

                            await updateEndTimeInDb(
                                productCount,
                                'running',
                                cmpid,
                                companyId,
                                null,
                                cronName,
                                cronStartTime,
                                ScrapingProductCount
                            );
                        }

                        const progress =
                            Number(
                                ((productCount / ScrapingProductCount) * 100)
                                    .toFixed(2)
                            );

                        /*
                        |--------------------------------------------------------------------------
                        | PRODUCT COMPLETE
                        |--------------------------------------------------------------------------
                        */

                        sendSSE('product_complete', {
                            status: true,
                            productNumber: productCount,
                            totalProducts: ScrapingProductCount,
                            progress,
                            productId:
                                product[`${companyId}_product_id`],
                            productCode:
                                product[`${companyId}_product_code`],
                            productPrice: varProductPrice,
                            productStock: varProductStock,
                            scrapeStatus
                        });

                        sendSSE('progress', {
                            status: true,
                            totalProducts: ScrapingProductCount,
                            processedProducts: productCount,
                            remainingProducts:
                                ScrapingProductCount - productCount,
                            progress,
                            productId:
                                product[`${companyId}_product_id`],
                            productCode:
                                product[`${companyId}_product_code`]
                        });

                    }
                    catch (error) {

                        console.error(
                            `Error scraping product ${product[`${companyId}_product_id`]}:`,
                            error.message
                        );

                        sendSSE('error', {
                            status: false,
                            productNumber: currentProductNumber,
                            totalProducts: ScrapingProductCount,
                            productId:
                                product[`${companyId}_product_id`],
                            productCode:
                                product[`${companyId}_product_code`],
                            productUrl,
                            message: error.message
                        });

                    }
                    finally {

                        /*
                        |--------------------------------------------------------------------------
                        | CLOSE THIS PRODUCT PAGE
                        |--------------------------------------------------------------------------
                        */

                        if (page) {

                            try {

                                await page.close();

                                console.log(
                                    `Page closed: ${product[`${companyId}_product_id`]}`
                                );

                                sendSSE('step', {
                                    status: true,
                                    step: 'page_closed',
                                    productNumber: currentProductNumber,
                                    productId:
                                        product[`${companyId}_product_id`],
                                    message: 'Product page closed successfully'
                                });

                            }
                            catch (closeError) {

                                console.error(
                                    'Error closing product page:',
                                    closeError.message
                                );
                            }

                            // Remove reference
                            page = null;
                        }

                        /*
                        |--------------------------------------------------------------------------
                        | SMALL CLEANUP DELAY
                        |--------------------------------------------------------------------------
                        */

                        await delay(100);

                        /*
                        |--------------------------------------------------------------------------
                        | OPTIONAL GC
                        |--------------------------------------------------------------------------
                        */

                        if (
                            global.gc &&
                            productCount % 20 === 0
                        ) {
                            global.gc();

                            console.log(
                                `Garbage collection triggered after ${productCount} products`
                            );
                        }
                    }
                }

                /*
                |--------------------------------------------------------------------------
                | END TIME
                |--------------------------------------------------------------------------
                */

                const endTime = new Date(
                    `${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`
                );

                const diffMs = endTime - startTime;

                const totalMins =
                    +(diffMs / 60000).toFixed(2);

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
                |--------------------------------------------------------------------------
                | FINAL SSE
                |--------------------------------------------------------------------------
                */

                sendSSE('complete', {
                    status: true,
                    message: "Scraping completed",
                    totalProcessed: productCount,
                    totalProducts: ScrapingProductCount,
                    progress: 100,
                    data: scrapedData
                });

                return res.end();

            }
            else {

                sendSSE('complete', {
                    status: true,
                    message: "Active products not found",
                    totalProcessed: 0,
                    data: []
                });

                return res.end();

            }

        }
        else {

            sendSSE('complete', {
                status: true,
                message: "Competitor Products not found",
                totalProcessed: 0,
                data: []
            });

            return res.end();

        }

    }
    catch (error) {

        console.error('Poorvika scraper error:', error);

        sendSSE('error', {
            status: false,
            message: error.message
        });

        return res.end();

    }
    finally {

        if (browser) {

            console.log('Closing browser...');

            await browser.close();

        }

    }

}

module.exports = { poorvikaScraper };