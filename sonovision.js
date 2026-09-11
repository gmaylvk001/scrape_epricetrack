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

const cronName = 'sonovision';

async function sonovisionScraper(req, res) {

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
                    `Sonovision returned HTTP ${response.status}`
                );
            }

            if (!response.data) {
                throw new Error('Empty response from Sonovision');
            }

            return response.data;

        } catch (error) {

            console.error(
                `sonovision request failed (attempt ${attempt}/${maxAttempts}):`,
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
    // PARSE sonovision PRODUCT HTML
    // ---------------------------------------------------------
    

    const parseSonovisionProduct = (html, productUrl = '') => {

        const $ = cheerio.load(html);

        let name = '';
        let price = '';
        let availability = '';
        let image = '';
        let review = 0;
        let rating = 0;

        try {

            // =====================================================
            // PRODUCT NAME
            // =====================================================

            name =
                $('h1.product_title').first().text().trim() ||
                $('h1.entry-title').first().text().trim() ||
                $('h1').first().text().trim();


            // =====================================================
            // PRODUCT IMAGE
            // =====================================================

            image =
                $('div[data-id="22e1bcb"] img').first().attr('src') ||
                $('div.woocommerce-product-gallery__image a img').first().attr('src') ||
                $('.woocommerce-product-gallery__image img').first().attr('src') ||
                '';


            // =====================================================
            // PRICE
            // =====================================================

            let productPrice = '';

            // -----------------------------------------------------
            // 1. VARIATION PRODUCT
            // -----------------------------------------------------

            const variationForm = $('form.variations_form').first();

            if (variationForm.length) {

                let variationData =
                    variationForm.attr('data-product_variations') || '';

                if (variationData) {

                    try {

                        // Decode HTML entities
                        variationData = $('<textarea>')
                            .html(variationData)
                            .text();

                        variationData = variationData
                            .replace(/\\"/g, '"');

                        const variations = JSON.parse(variationData);

                        // -------------------------------------------------
                        // Get selected query parameter
                        // Example:
                        // ?attribute_pa_size=65-inch
                        // -------------------------------------------------

                        const url = new URL(productUrl);

                        let selectedAttribute = '';
                        let selectedValue = '';

                        for (const [key, value] of url.searchParams.entries()) {
                            selectedAttribute = key;
                            selectedValue = value;
                            break;
                        }

                        // -------------------------------------------------
                        // Find matching variation
                        // -------------------------------------------------

                        if (Array.isArray(variations)) {

                            for (const variation of variations) {

                                const attributes = variation.attributes || {};

                                if (
                                    selectedAttribute &&
                                    selectedValue &&
                                    attributes[selectedAttribute] === selectedValue
                                ) {
                                    productPrice = variation.display_price;
                                    break;
                                }
                            }

                            // If no query parameter match,
                            // use first available variation
                            if (!productPrice) {

                                const availableVariation = variations.find(
                                    variation =>
                                        variation.variation_is_active !== false &&
                                        variation.is_in_stock !== false &&
                                        variation.display_price
                                );

                                if (availableVariation) {
                                    productPrice =
                                        availableVariation.display_price;
                                }
                            }
                        }

                    } catch (error) {

                        console.log(
                            'Sonovision variation parse error:',
                            error.message
                        );
                    }
                }
            }


            // -----------------------------------------------------
            // 2. NORMAL WOOCOMMERCE PRICE
            // -----------------------------------------------------

            if (!productPrice) {

                const priceElement =
                    $('.elementor-widget-woocommerce-product-price')
                        .first();

                if (priceElement.length) {

                    const priceSpans =
                        priceElement.find('span.woocommerce-Price-amount');

                    if (priceSpans.length > 1) {

                        productPrice =
                            $(priceSpans[1]).text().trim();

                    } else if (priceSpans.length === 1) {

                        productPrice =
                            $(priceSpans[0]).text().trim();
                    }
                }
            }


            // -----------------------------------------------------
            // 3. FALLBACK WOOCOMMERCE PRICE
            // -----------------------------------------------------

            if (!productPrice) {

                productPrice =
                    $('.summary .price .woocommerce-Price-amount')
                        .first()
                        .text()
                        .trim();
            }


            // =====================================================
            // CLEAN PRICE
            // =====================================================

            if (productPrice) {

                productPrice = productPrice
                    .replace(/&#8377;/g, '')
                    .replace(/₹/g, '')
                    .replace(/,/g, '')
                    .replace(/[^0-9.]/g, '')
                    .trim();

                const numericPrice = parseFloat(productPrice);

                if (!isNaN(numericPrice) && numericPrice > 0) {
                    price = numericPrice;
                }
            }


            // =====================================================
            // STOCK
            // =====================================================

            const outOfStock =
                $('div.elementor-add-to-cart.elementor-product-simple')
                    .find('p.stock.out-of-stock')
                    .length > 0;

            if (outOfStock) {

                price = '';
                availability = 'Out of stock';

            } else {

                const stockElement =
                    $('p.stock')
                        .first();

                if (stockElement.length) {

                    const stockText =
                        stockElement.text().trim();

                    if (/out of stock/i.test(stockText)) {

                        price = '';
                        availability = 'Out of stock';
                    } else {
                        availability = 'In stock';
                    }

                } else {

                    // Same logic as your PHP code:
                    // if price exists and no out-of-stock element
                    availability = price ? 'In stock' : '';
                }
            }


            // =====================================================
            // REVIEWS / RATING
            // =====================================================

            const ratingValue =
                $('.woocommerce-product-rating .star-rating')
                    .attr('aria-label');

            if (ratingValue) {

                const match = ratingValue.match(/([\d.]+)/);

                if (match) {
                    rating = parseFloat(match[1]);
                }
            }

            const reviewText =
                $('.woocommerce-review-link')
                    .first()
                    .text()
                    .trim();

            if (reviewText) {

                const match = reviewText.match(/(\d+)/);

                if (match) {
                    review = parseInt(match[1], 10);
                }
            }


        } catch (error) {

            console.log(
                'Sonovision parser error:',
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
            message: 'Sonovision scraping started',
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
                    'ept_product_details_new_sonovision',
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
                    .startsWith('https://sonovision.in/')
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

            if (!hostname.includes('sonovision.in')) {

                sendSSE('warning', {

                    message:
                        'Only Sonovision URLs supported',

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
                    parseSonovisionProduct(html);

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
                            'ept_product_details_new_sonovision',
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
                    `Error scraping Sonovision product ${productId}:`,
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
                'Sonovision scraping completed',

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
            'Sonovision scraper fatal error:',
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
    sonovisionScraper
};
