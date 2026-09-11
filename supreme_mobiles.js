const axios = require('axios');
const cheerio = require('cheerio');

const {
    executeMongoFind,
    executeMongoCount,
    executeMongoUpdate
} = require('./mongo');

const {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb
} = require('./utils/cronTime');

const {
    updatePriceChangeData
} = require('./utils/priceChange');

const cronName = 'supreme_mobiles';

async function supremeMobilesScraper(req, res) {

    // ---------------------------------------------------------
    // SSE SETUP
    // ---------------------------------------------------------

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Flush headers immediately
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    const sendSSE = (type, data) => {
        try {
            if (res.writableEnded || res.destroyed) {
                return;
            }

            res.write(`event: ${type}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);

            if (typeof res.flush === 'function') {
                res.flush();
            }
        } catch (error) {
            console.error('SSE send error:', error.message);
        }
    };

    // ---------------------------------------------------------
    // CURL / HTTP CONFIG
    // ---------------------------------------------------------

    const USER_AGENT =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

    
    const fetchProductPage = async (url, attempt = 1) => {

        const maxAttempts = 3;

        try {

            const response = await axios.get(url, {
                timeout: 30000,

                maxRedirects: 5,

                // Do not throw for normal HTTP responses.
                validateStatus: (status) => {
                    return status >= 200 && status < 500;
                },

                headers: {
                    'User-Agent': USER_AGENT,

                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
                        'image/avif,image/webp,*/*;q=0.8',

                    'Accept-Language':
                        'en-IN,en;q=0.9,en-US;q=0.8',

                    'Accept-Encoding':
                        'gzip, deflate, br',

                    'Cache-Control':
                        'no-cache',

                    'Pragma':
                        'no-cache',

                    'Upgrade-Insecure-Requests':
                        '1',

                    'Sec-Fetch-Dest':
                        'document',

                    'Sec-Fetch-Mode':
                        'navigate',

                    'Sec-Fetch-Site':
                        'none',

                    'Sec-Fetch-User':
                        '?1',

                    'Connection':
                        'keep-alive'
                },

                // Prevent axios from converting response unexpectedly.
                responseType: 'text',

                decompress: true
            });

            if (response.status < 200 || response.status >= 400) {
                throw new Error(
                    `Supreme Mobiles returned HTTP ${response.status}`
                );
            }

            if (!response.data) {
                throw new Error('Empty response from Supreme Mobiles');
            }

            return response.data;

        } catch (error) {

            console.error(
                `Supreme Mobiles request failed (attempt ${attempt}/${maxAttempts}):`,
                error.message
            );

            if (attempt < maxAttempts) {

                // Small retry delay
                await new Promise(resolve =>
                    setTimeout(resolve, 1500 * attempt)
                );

                return fetchProductPage(
                    url,
                    attempt + 1
                );
            }

            throw error;
        }
    };

    // ---------------------------------------------------------
    // PARSE Supreme Mobiles PRODUCT HTML
    // ---------------------------------------------------------
    

    const parseSupremeMobilesProduct = (html) => {

        const $ = cheerio.load(html);

        let name = '';
        let price = '';
        let availability = '';
        let image = '';
        let review = 0;
        let rating = 0;

        try {

            // ============================================
            // 1. CHECK 404 / PRODUCT PAGE
            // ============================================

            const is404 = $('div.m-page404').length > 0;
            const isProductPage = $('div.m-main-product--wrapper').length > 0;

            if (is404 || !isProductPage) {
                return {
                    name,
                    price,
                    availability,
                    image,
                    review,
                    rating
                };
            }


            // ============================================
            // 2. PRODUCT IMAGE
            // responsive-image img
            // ============================================

            image = $('responsive-image img').first().attr('src') || '';

            if (image && image.startsWith('//')) {
                image = `https:${image}`;
            }


            // ============================================
            // 3. STOCK STATUS
            // PHP:
            // span[class=m-add-to-cart--text]
            // ============================================

            const stockText = $('span.m-add-to-cart--text')
                .first()
                .text()
                .trim();

            if (
                stockText &&
                !stockText.toLowerCase().includes('sold out')
            ) {
                availability = 'In stock';
            } else {
                availability = 'Out of stock';
            }


            // ============================================
            // 4. EXTRACT SHOPIFY "Viewed Product" JSON
            // Same logic as PHP explode()
            // ============================================

            if (html.includes('("Viewed Product"')) {

                let productJson = html
                    .split('("Viewed Product",')[1];

                if (productJson) {

                    productJson = productJson
                        .split('window.ShopifyAnalytics.')[0]
                        .split(',undefined,undefined,{"shopifyEmitted":true}')[0]
                        .trim();

                    try {

                        const productData = JSON.parse(productJson);

                        // ============================================
                        // 5. PRODUCT NAME
                        // ============================================

                        name =
                            productData.name ||
                            productData.title ||
                            $('h1').first().text().trim();


                        // ============================================
                        // 6. PRODUCT PRICE
                        // ============================================

                        if (productData.price !== undefined) {

                            price = parseFloat(
                                String(productData.price)
                                    .replace(/[^0-9.]/g, '')
                            );

                            if (!price || price <= 0) {
                                price = '';
                                availability = 'Out of stock';
                            }

                        }

                    } catch (jsonError) {

                        console.log(
                            'Supreme Mobiles JSON parse error:',
                            jsonError.message
                        );

                    }

                }

            }


            // ============================================
            // 7. FALLBACK NAME
            // ============================================

            if (!name) {

                name =
                    $('h1.m-product-title')
                        .first()
                        .text()
                        .trim() ||
                    $('h1')
                        .first()
                        .text()
                        .trim();

            }


            // ============================================
            // 8. FALLBACK PRICE FROM HTML
            // ============================================

            if (!price) {

                const priceText =
                    $('.m-price-item--sale')
                        .first()
                        .text()
                        .trim() ||
                    $('.price')
                        .first()
                        .text()
                        .trim();

                const parsedPrice = parseFloat(
                    priceText.replace(/[^0-9.]/g, '')
                );

                if (parsedPrice > 0) {
                    price = parsedPrice;
                }

            }


        } catch (error) {

            console.log(
                'Error parsing Supreme Mobiles product:',
                error.message
            );

        }


        return {
            name,
            price,
            availability,
            image,
            review,
            rating
        };
    };

    // ---------------------------------------------------------
    // MAIN
    // ---------------------------------------------------------

    try {

        const cmpid = req.query.cmpid;

        if (!cmpid) {

            sendSSE('error', {
                message: 'cmpid is required'
            });

            return res.end();
        }

        const companyId =
            cmpid.replace('plm_user_info_', '');

        const ean = req.query.ean;
        const itemcode = req.query.itemcode;

        const isSingleProduct =
            !!(ean && itemcode);

        // -----------------------------------------------------
        // START
        // -----------------------------------------------------

        sendSSE('start', {
            status: true,
            message: 'Supreme Mobiles scraping started',
            cmpid,
            companyId,
            isSingleProduct
        });

        // -----------------------------------------------------
        // FILTER
        // -----------------------------------------------------

        const filter = {

            status: 'active',

            product_scrape_status: {
                $in: [
                    'pending',
                    'completed'
                ]
            },

            product_url: {
                $nin: [
                    '',
                    null,
                    'No Result'
                ]
            }
        };

        // -----------------------------------------------------
        // SINGLE PRODUCT
        // -----------------------------------------------------

        if (isSingleProduct) {

            filter[
                `${companyId}_product_id`
            ] = ean;

            filter[
                `${companyId}_product_code`
            ] = itemcode;
        }

        // -----------------------------------------------------
        // FETCH PRODUCTS
        // -----------------------------------------------------

        sendSSE('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching products from database...'
        });

        const products = await executeMongoFind(
            {
                collection:
                    'ept_product_details_new_supreme_mobiles',
                cmpid
            },
            filter,
            {
                _id: 0
            }
        );

        // -----------------------------------------------------
        // NO PRODUCTS
        // -----------------------------------------------------

        if (!products || products.length === 0) {

            sendSSE('complete', {
                status: true,
                message: 'Products Not Found',
                totalProcessed: 0,
                data: []
            });

            return res.end();
        }

        sendSSE('products_found', {
            message:
                `Found ${products.length} products in source collection`,
            count: products.length
        });

        // -----------------------------------------------------
        // FETCH EXISTING PRODUCTS
        // -----------------------------------------------------

        sendSSE('step', {
            step: 'matching',
            status: 'running',
            message: 'Matching products with main product collection...'
        });

        const existingProducts =
            await executeMongoFind(
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
                            ean_product_data_details_scrap_status:
                                'completed'
                        }
                    ]
                },
                {
                    _id: 0,
                    product_ean_id: 1,
                    product_code: 1
                }
            );

        // -----------------------------------------------------
        // CREATE PRODUCT MAP
        // -----------------------------------------------------
  

        const productMap = new Set();

        if (Array.isArray(existingProducts)) {

            existingProducts.forEach(row => {

                const key =
                    `${row.product_ean_id}_${row.product_code}`;

                productMap.add(key);
            });
        }

        // -----------------------------------------------------
        // FILTER PRODUCTS
        // -----------------------------------------------------

        const ArrGetProductInfo = [];

        products.forEach(product => {

            const productId =
                product[
                    `${companyId}_product_id`
                ];

            const productCode =
                product[
                    `${companyId}_product_code`
                ];

            const productUrl =
                product.product_url;

            if (!productUrl) {
                return;
            }

            const key =
                `${productId}_${productCode}`;

            // Only matching main products
            if (!productMap.has(key)) {
                return;
            }

            // Only Relinace Digital URLs
            if (
                !productUrl
                    .toLowerCase()
                    .startsWith('https://suprememobiles.in/')
            ) {
                return;
            }

            ArrGetProductInfo.push(product);
        });


        // -----------------------------------------------------
        // NO MATCHING PRODUCTS
        // -----------------------------------------------------

        if (ArrGetProductInfo.length === 0) {

            sendSSE('complete', {
                status: true,
                message: 'Active Products Not Found',
                totalProcessed: 0,
                data: []
            });

            return res.end();
        }

        sendSSE('filtered_products', {
            message:
                `Found ${ArrGetProductInfo.length} products to scrape`,
            count:
                ArrGetProductInfo.length
        });

        // -----------------------------------------------------
        // SCRAPING COUNT
        // -----------------------------------------------------

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

        const cronStarttime =
            getCurrentIndTimeInfo();

        // -----------------------------------------------------
        // CRON START
        // -----------------------------------------------------

        if (!isSingleProduct) {

            await updateStartTimeInDb(
                cmpid,
                companyId,
                cronName,
                ScrapingProductCount
            );
        }

        let productCount = 0;

        const scrapedData = [];

        // -----------------------------------------------------
        // PRODUCT LOOP
        // -----------------------------------------------------

        for (
            const product
            of ArrGetProductInfo
        ) {

            const productId =
                product[
                    `${companyId}_product_id`
                ];

            const productCode =
                product[
                    `${companyId}_product_code`
                ];

            const productUrl =
                product.product_url;

            // -------------------------------------------------
            // PROGRESS
            // -------------------------------------------------

            sendSSE('progress', {

                current:
                    productCount + 1,

                total:
                    ScrapingProductCount,

                product_id:
                    productId,

                product_code:
                    productCode,

                url:
                    productUrl,

                percentage:
                    Math.round(
                        (
                            (productCount + 1) /
                            ScrapingProductCount
                        ) * 100
                    )
            });

            // -------------------------------------------------
            // URL VALIDATION
            // -------------------------------------------------

            let hostname;

            try {

                hostname =
                    new URL(productUrl)
                        .hostname
                        .toLowerCase();

            } catch (error) {

                sendSSE('product_error', {

                    product_id:
                        productId,

                    product_code:
                        productCode,

                    error:
                        'Invalid product URL'
                });

                continue;
            }

            if (!hostname.includes('suprememobiles.in')) {

                sendSSE('warning', {

                    message:
                        'Only Supreme Mobiles URLs supported',

                    url:
                        productUrl
                });

                continue;
            }

            // -------------------------------------------------
            // DEFAULT VALUES
            // -------------------------------------------------

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

            // -------------------------------------------------
            // SCRAPE
            // -------------------------------------------------

            try {

                sendSSE('product_start', {

                    product_id:
                        productId,

                    product_code:
                        productCode,

                    url:
                        productUrl,

                    status:
                        'scraping'
                });

                // -------------------------------------------------
                // HTTP REQUEST
                // -------------------------------------------------

                const html =
                    await fetchProductPage(
                        productUrl
                    );
            

                // -------------------------------------------------
                // PARSE HTML
                // -------------------------------------------------

                const result =
                    parseSupremeMobilesProduct(html);

                // -------------------------------------------------
                // PRODUCT NOT FOUND
                // -------------------------------------------------

                if (result === null) {

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

                    sendSSE('product_failed', {

                        product_id:
                            productId,

                        product_code:
                            productCode,

                        reason:
                            'Product JSON/schema not found'
                    });

                } else {

                    // -------------------------------------------------
                    // AVAILABILITY
                    // -------------------------------------------------

                    const status =
                        (
                            result.availability ||
                            ''
                        )
                            .toLowerCase()
                            .trim();

                    // -------------------------------------------------
                    // IMAGE
                    // -------------------------------------------------

                    varProductImage =
                        result.image ||
                        'No Result';

                    // -------------------------------------------------
                    // REVIEW
                    // -------------------------------------------------

                    varProductReview =
                        parseFloat(
                            result.review
                        ) || 0;

                    // -------------------------------------------------
                    // RATING
                    // -------------------------------------------------

                    varProductRating =
                        parseFloat(
                            result.rating
                        ) || 0;

                    // -------------------------------------------------
                    // PRICE
                    // -------------------------------------------------

                    const cleanedPrice =
                        result.price || '';

                    const numericPrice =
                        parseFloat(
                            String(cleanedPrice)
                                .replace(/[^0-9.]/g, '')
                        ) || 0;

                    // -------------------------------------------------
                    // STOCK
                    // -------------------------------------------------

                    if (
                        (
                            status.includes('instock') ||
                            status.includes('in stock')
                        ) &&
                        numericPrice > 0
                    ) {

                        varProductPrice =
                            numericPrice;

                        varProductStock =
                            'In stock';

                    } else if (
                        status.includes('outofstock') ||
                        status.includes('out of stock') ||
                        status.includes('currently unavailable')
                    ) {

                        varProductStock =
                            'Out Of Stock';

                        // Keep price as No Result
                        // for unavailable products.

                    } else {

                        // Unknown availability.
                        // If price exists, keep it,
                        // otherwise No Result.

                        if (numericPrice > 0) {

                            varProductPrice =
                                numericPrice;
                        }

                        if (status) {

                            varProductStock =
                                status;
                        }
                    }

                    scrapeStatus =
                        'completed';
                }

                // -------------------------------------------------
                // MODIFIED DATE
                // -------------------------------------------------

                const modifiedDate =
                    getCurrentIndTimeInfo(
                        'India_Railway_Date_Time'
                    );

                // -------------------------------------------------
                // PRICE CHANGE
                // -------------------------------------------------

                await updatePriceChangeData(

                    scrapeStatus,

                    product.product_price,

                    varProductPrice,

                    productId,

                    productCode,

                    cronName,

                    cmpid,

                    companyId
                );

                // -------------------------------------------------
                // UPDATE MONGO
                // -------------------------------------------------

                await executeMongoUpdate(

                    {
                        collection:
                            'ept_product_details_new_supreme_mobiles',
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

                            modified_date:
                                modifiedDate,

                            product_scrape_status:
                                scrapeStatus,

                            product_review:
                                varProductReview,

                            product_rating:
                                varProductRating
                        }
                    }
                ); 

                // -------------------------------------------------
                // RESULT
                // -------------------------------------------------

                const scrapedItem = {

                    product_ean_id:
                        productId,

                    product_code:
                        productCode,

                    product_price:
                        varProductPrice,

                    product_stock:
                        varProductStock,
                    
                    product_review:
                        varProductReview,
                    
                    product_rating:
                        varProductRating,

                    modified_date:
                        modifiedDate
                };

                scrapedData.push(
                    scrapedItem
                );

                productCount++;

                // -------------------------------------------------
                // PRODUCT SCRAPED EVENT
                // -------------------------------------------------

                sendSSE(
                    'product_scraped',
                    {

                        ...scrapedItem,

                        scrape_status:
                            scrapeStatus,

                        progress: {

                            current:
                                productCount,

                            total:
                                ScrapingProductCount,

                            percentage:
                                Math.round(
                                    (
                                        productCount /
                                        ScrapingProductCount
                                    ) * 100
                                )
                        }
                    }
                );

                // -------------------------------------------------
                // CRON UPDATE
                // -------------------------------------------------

                if (!isSingleProduct) {

                    await updateEndTimeInDb(

                        productCount,

                        'running',

                        cmpid,

                        companyId,

                        null,

                        cronName,

                        cronStarttime,

                        ScrapingProductCount
                    );
                }

            } catch (error) {

                console.error(
                    `Error scraping Supreme Mobiles product ${productId}:`,
                    error.message
                );

                // ---------------------------------------------
                // PRODUCT ERROR
                // ---------------------------------------------

                sendSSE(
                    'product_error',
                    {

                        product_id:
                            productId,

                        product_code:
                            productCode,

                        error:
                            error.message
                    }
                );

                // ---------------------------------------------
                // Do NOT stop entire scraper.
                // Continue next product.
                // ---------------------------------------------

                continue;
            }
        }

        // ---------------------------------------------------------
        // END TIME
        // ---------------------------------------------------------

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

        // ---------------------------------------------------------
        // CRON END
        // ---------------------------------------------------------

        if (!isSingleProduct) {

            await updateEndTimeInDb(

                productCount,

                'ending',

                cmpid,

                companyId,

                totalMins,

                cronName,

                cronStarttime,

                ScrapingProductCount
            );
        }

        // ---------------------------------------------------------
        // COMPLETE
        // ---------------------------------------------------------

        sendSSE('complete', {

            status: true,

            message:
                'Supreme Mobiles scraping completed',

            totalProcessed:
                productCount,

            totalProducts:
                ScrapingProductCount,

            totalMins,

            data:
                scrapedData
        });

        return res.end();

    } catch (error) {

        console.error(
            'Supreme Mobiles scraper fatal error:',
            error
        );

        sendSSE('error', {

            status: false,

            message:
                error.message,

            stack:
                process.env.NODE_ENV === 'development'
                    ? error.stack
                    : undefined
        });

        return res.end();
    }
}

module.exports = {
    supremeMobilesScraper
};
