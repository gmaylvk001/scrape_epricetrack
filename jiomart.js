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

const cronName = 'jiomart';

async function jiomartScraper(req, res) {

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


    // ---------------------------------------------------------
    // PARSE jiomart PRODUCT HTML
    // ---------------------------------------------------------

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
                        `Adishware Store returned HTTP ${response.status}`
                    );
                }
    
                if (!response.data) {
                    throw new Error('Empty response from Adishware Store');
                }
    
                return response.data;
    
            } catch (error) {
    
                console.error(
                    `Adishware Store request failed (attempt ${attempt}/${maxAttempts}):`,
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
    

    // =========================================================
    // JIOMART API
    // =========================================================

    const fetchJiomartProduct = async (html, productUrl) => {

        try {

            const $ = cheerio.load(html);

            // -------------------------------------------------
            // GET SLUG FROM PRODUCT URL
            // -------------------------------------------------

            const url = new URL(productUrl);

            const pathParts = url.pathname
                .split('/')
                .filter(Boolean);

            const slug = pathParts[pathParts.length - 1];

            if (!slug) {
                throw new Error('JioMart product slug not found');
            }

            // -------------------------------------------------
            // COMMON HEADERS
            // -------------------------------------------------

            const headers = {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-IN,en;q=0.9,en-US;q=0.8',
                'Content-Type': 'application/json',
                'Origin': 'https://www.jiomart.com',
                'Referer': productUrl,
                'Authorization': 'Bearer Njg1OTQ1ZjQ2YzhjN2FlZTNmM2FmNjA1OlRwS3c3d0Q5aA=='
            };

            // -------------------------------------------------
            // PRICE API
            // -------------------------------------------------

            const priceApiUrl =
                'https://www.jiomart.com/api/service/application/catalog/v1.0/products/sizes/price';

            const pricePayload = {
                items: [
                    {
                        slug: slug,
                        size: 'OS',
                        is_tradein_opted: false
                    }
                ]
            };

            const priceResponse = await axios.post(
                priceApiUrl,
                pricePayload,
                {
                    timeout: 30000,
                    headers
                }
            );

            const priceData = priceResponse.data;
            
            // -------------------------------------------------
            // PRODUCT DATA
            // -------------------------------------------------

            const item =
                priceData?.items?.[0] ||
                priceData?.data?.items?.[0];
            

            if (!item) {
                throw new Error('JioMart product API data not found');
            }

            const name =
                item.product_name || '';

           
            const priceMatch = html.match(
                /"price-rrp"\s*:\s*"([^"]+)"/
            );
            if (priceMatch) {
                price = parseFloat(priceMatch[1]) || 0;
            }else{
                
                price =
                parseFloat(item?.price?.effective) || 0;
            }

            const quantity =
                Number(item.quantity) || 0;

            // -------------------------------------------------
            // AVAILABILITY
            // -------------------------------------------------

            const availability =
                quantity > 0
                    ? 'In stock'
                    : 'Out Of Stock';

            // -------------------------------------------------
            // IMAGE
            // -------------------------------------------------

            let image = '';

            // Try image fields from API response
            image =
                item.image ||
                item.image_url ||
                item.imageUrl ||
                item.product_image ||
                item.product_image_url ||
                '';

            // If images array exists
            if (!image && Array.isArray(item.images)) {

                const firstImage = item.images[0];

                if (typeof firstImage === 'string') {
                    image = firstImage;
                } else if (firstImage) {
                    image =
                        firstImage.url ||
                        firstImage.image_url ||
                        firstImage.imageUrl ||
                        '';
                }
            }

            // -------------------------------------------------
            // FALLBACK - GET IMAGE FROM PRODUCT PAGE
            // -------------------------------------------------

            if (!image) {

                try {

                    const pageResponse = await axios.get(
                        productUrl,
                        {
                            timeout: 30000,
                            headers: {
                                'User-Agent': USER_AGENT,
                                'Accept': 'text/html,application/xhtml+xml'
                            }
                        }
                    );

                    const html = pageResponse.data;

                    // Find og:image
                    const ogImageMatch =
                        html.match(
                            /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
                        );

                    if (ogImageMatch?.[1]) {
                        image = ogImageMatch[1];
                    }

                    // Alternative order:
                    if (!image) {

                        const ogImageMatch2 =
                            html.match(
                                /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
                            );

                        if (ogImageMatch2?.[1]) {
                            image = ogImageMatch2[1];
                        }
                    }

                } catch (imageError) {

                    console.error(
                        'JioMart image fetch failed:',
                        imageError.message
                    );

                }
            }

            // -------------------------------------------------
            // ARTICLE ID
            // -------------------------------------------------

            const articleIdRaw =
                item.article_id ||
                item.articleId ||
                '';

            let articleId = '';

            if (articleIdRaw) {

                const articleParts =
                    String(articleIdRaw).split('_');

                articleId =
                    articleParts[articleParts.length - 1];
            }

            // -------------------------------------------------
            // REVIEW / RATING
            // -------------------------------------------------

            let review = 0;
            let rating = 0;

            if (articleId) {

                const reviewApiUrl =
                    `https://www.jiomart.com/ext/jcp-jiomart/application/v1.0/op/review/product-statistics/${articleId}`;

                try {

                    const reviewResponse =
                        await axios.get(
                            reviewApiUrl,
                            {
                                timeout: 30000,
                                headers
                            }
                        );

                    const reviewData =
                        reviewResponse.data;

                    const statistics =
                        reviewData?.data ||
                        reviewData;

                    rating =
                        parseFloat(
                            statistics?.averageRating
                        ) || 0;

                    review =
                        parseInt(
                            statistics?.ratingsCount,
                            10
                        ) || 0;

                } catch (reviewError) {

                    console.error(
                        `JioMart review API failed for ${articleId}:`,
                        reviewError.message
                    );

                    review = 0;
                    rating = 0;
                }
            }

            // -------------------------------------------------
            // RETURN
            // -------------------------------------------------

            return {
                name,
                price,
                availability,
                image,
                review,
                rating
            };

        } catch (error) {

            console.error(
                'JioMart API error:',
                error.message
            );

            throw error;
        }
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
            message: 'Jiomart scraping started',
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
                    'ept_product_details_new_jiomart',
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
                    .startsWith('https://www.jiomart.com/')
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

            if (!hostname.includes('jiomart.com')) {

                sendSSE('warning', {

                    message:
                        'Only Jiomart URLs supported',

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

               
                // -------------------------------------------------
                // PARSE HTML
                // -------------------------------------------------

                const html =
                    await fetchProductPage(
                        productUrl
                    );

                const result =
                  await fetchJiomartProduct(html, productUrl);

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
                            'ept_product_details_new_jiomart',
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
                    `Error scraping Jiomart product ${productId}:`,
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
                'Jiomart scraping completed',

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
            'Jiomart scraper fatal error:',
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
    jiomartScraper
};
