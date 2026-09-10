const axios = require('axios');

const {
    executeMongoFind,
    executeMongoUpdate
} = require('./mongo');

const {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb
} = require('./utils/cronTime');

const { getStorePincode } = require('./utils/pinCode');

const { updatePriceChangeData } = require('./utils/priceChange');

const CRON_NAME = 'sangeetha_mobiles';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/**
 * Sets up Server-Sent Events (SSE) headers and returns a send function.
 */
function setupSSE(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

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

    return sendSSE;
}

/**
 * Extracts product ID from a Sangeetha Mobiles product URL.
 * Returns the ID or null if invalid.
 */
function extractProductIdFromUrl(productUrl) {
    try {
        const url = new URL(productUrl);
        const pathParts = url.pathname.split('/').filter(Boolean);
        const productId = pathParts[pathParts.length - 1];

        if (!/^\d+$/.test(productId)) {
            return null;
        }
        return productId;
    } catch {
        return null;
    }
}

/**
 * Fetches product details and stock information from Sangeetha Mobiles APIs.
 * Returns an object with name, price, image, availability, review, rating.
 */
async function fetchSangeethaProductData(productUrl, pincode, sendSSE) {
    const productId = extractProductIdFromUrl(productUrl);
    if (!productId) {
        sendSSE('product_error', {
            url: productUrl,
            product_id: productId,
            error: 'Product ID not found in URL'
        });
        return null;
    }

    const apiUrl = 'https://www.sangeethamobiles.com/b/customer/api/v3/product-details';
    const stockUrl = 'https://www.sangeethamobiles.com/b/customer/api/v3/product-eta-details';

    const payload = {
        type: 'desktop',
        product_id: productId,
        pinCode: pincode,
        user_id: ''
    };

    const commonHeaders = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9,ta;q=0.8',
        'Origin': 'https://www.sangeethamobiles.com',
        'Referer': productUrl
    };

    try {
        const [apiRes, stockRes] = await Promise.all([
            fetch(apiUrl, {
                method: 'POST',
                headers: commonHeaders,
                body: JSON.stringify(payload)
            }),
            fetch(stockUrl, {
                method: 'POST',
                headers: commonHeaders,
                body: JSON.stringify(payload)
            })
        ]);

        if (!apiRes.ok) {
            throw new Error(`Sangeetha Product API failed with status ${apiRes.status}`);
        }

        const apiText = await apiRes.text();
        const stockText = await stockRes.text();

        let apiData, stockData;
        try {
            apiData = JSON.parse(apiText);
            stockData = JSON.parse(stockText);
        } catch (parseError) {
            throw new Error('Invalid JSON response from Sangeetha Product API');
        }

        sendSSE('product_api_response', {
            product_url: productUrl,
            product_id: productId,
            status: apiRes.status
        });

        const name = apiData?.data?.[0]?.item_fullname || 'No Result';
        const price = apiData?.data?.[0]?.sale_price || 0;
        const image = apiData?.data?.[0]?.img_details?.[0]?.file_url || 'No Result';
        const availability = stockData?.data?.product_eta?.stock_status;

        return {
            name,
            price,
            image,
            availability,
            review: 0,
            rating: 0
        };
    } catch (error) {
        sendSSE('product_error', {
            url: productUrl,
            error: error.message
        });
        return null;
    }
}

/**
 * Processes a single product: fetches data, updates database, sends SSE events.
 */
async function processProduct(product, companyId, pincode, sendSSE, scrapedData, productCount, ScrapingProductCount, cmpid, isSingleProduct, cronStarttime) {
    const productId = product[`${companyId}_product_id`];
    const productCode = product[`${companyId}_product_code`];
    const productUrl = product.product_url;

    // Progress event
    sendSSE('progress', {
        current: productCount + 1,
        total: ScrapingProductCount,
        product_id: productId,
        product_code: productCode,
        url: productUrl,
        percentage: Math.round(((productCount + 1) / ScrapingProductCount) * 100)
    });

    // Validate URL
    let hostname;
    try {
        hostname = new URL(productUrl).hostname.toLowerCase();
    } catch {
        sendSSE('product_error', {
            product_id: productId,
            product_code: productCode,
            error: 'Invalid product URL'
        });
        return productCount; // unchanged
    }

    if (!hostname.includes('www.sangeethamobiles.com')) {
        sendSSE('warning', {
            message: 'Only sangeethamobiles URLs supported',
            url: productUrl
        });
        return productCount;
    }

    // Default values
    let varProductPrice = 'No Result';
    let varProductStock = 'No Result';
    let varProductImage = 'No Result';
    let varProductReview = 'No Result';
    let varProductRating = 'No Result';
    let scrapeStatus = 'pending';

    try {
        sendSSE('product_start', {
            product_id: productId,
            product_code: productCode,
            url: productUrl,
            status: 'scraping'
        });

        const result = await fetchSangeethaProductData(productUrl, pincode, sendSSE);

        if (result === null) {
            // Product not found (404 or invalid)
            varProductPrice = 'No Result';
            varProductStock = 'No Result';
            varProductImage = 'No Result';
            varProductReview = 'No Result';
            varProductRating = 'No Result';
            scrapeStatus = 'pending';

            sendSSE('product_failed', {
                product_id: productId,
                product_code: productCode,
                reason: 'Not a Product Page. A 404 Page'
            });
        } else {
            // Process availability
            const status = (result.availability || '').toLowerCase().trim();

            varProductImage = result.image || 'No Result';
            varProductReview = parseFloat(result.review) || 0;
            varProductRating = parseFloat(result.rating) || 0;

            const cleanedPrice = result.price || '';
            const numericPrice = parseFloat(String(cleanedPrice).replace(/[^0-9.]/g, '')) || 0;

            if ((status.includes('instock') || status.includes('in stock')) && numericPrice > 0) {
                varProductPrice = numericPrice;
                varProductStock = 'In stock';
            } else if (status.includes('outofstock') || status.includes('out of stock') || status.includes('currently unavailable')) {
                varProductStock = 'Out Of Stock';
                // Keep price as 'No Result' for unavailable products
            } else {
                // Unknown availability – if price exists, keep it
                if (numericPrice > 0) {
                    varProductPrice = numericPrice;
                }
                if (status) {
                    varProductStock = status;
                }
            }
            scrapeStatus = 'completed';
        }

        // Modified date
        const modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

        // Update price change data
        await updatePriceChangeData(
            scrapeStatus,
            product.product_price,
            varProductPrice,
            productId,
            productCode,
            CRON_NAME,
            cmpid,
            companyId
        );

        // Update MongoDB
        await executeMongoUpdate(
            {
                collection: 'ept_product_details_new_sangeetha_mobiles',
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
                    modified_date: modifiedDate,
                    product_scrape_status: scrapeStatus,
                    product_review: varProductReview,
                    product_rating: varProductRating
                }
            }
        );

        // Build scraped item
        const scrapedItem = {
            product_ean_id: productId,
            product_code: productCode,
            product_price: varProductPrice,
            product_stock: varProductStock,
            product_review: varProductReview,
            product_rating: varProductRating,
            modified_date: modifiedDate
        };

        scrapedData.push(scrapedItem);
        productCount++;

        // Send product_scraped event
        sendSSE('product_scraped', {
            ...scrapedItem,
            scrape_status: scrapeStatus,
            progress: {
                current: productCount,
                total: ScrapingProductCount,
                percentage: Math.round((productCount / ScrapingProductCount) * 100)
            }
        });

        // Update cron progress if not single product
        if (!isSingleProduct) {
            await updateEndTimeInDb(
                productCount,
                'running',
                cmpid,
                companyId,
                null,
                CRON_NAME,
                cronStarttime,
                ScrapingProductCount
            );
        }

    } catch (error) {
        console.error(`Error scraping sangeetha_mobiles product ${productId}:`, error.message);
        sendSSE('product_error', {
            product_id: productId,
            product_code: productCode,
            error: error.message
        });
        // Continue to next product
    }

    return productCount;
}

/**
 * Main scraper function – exported as route handler.
 */
async function sangeethamobilesScraper(req, res) {
    const sendSSE = setupSSE(res);

    try {
        const cmpid = req.query.cmpid;
        if (!cmpid) {
            sendSSE('error', { message: 'cmpid is required' });
            return res.end();
        }

        const companyId = cmpid.replace('plm_user_info_', '');
        const ean = req.query.ean;
        const itemcode = req.query.itemcode;
        const isSingleProduct = !!(ean && itemcode);

        let pincode = await getStorePincode(companyId);
        if (pincode === null) {
            pincode = req.query.pincode || '600008';
        }

        sendSSE('start', {
            status: true,
            message: 'sangeethamobiles scraping started',
            cmpid,
            companyId,
            isSingleProduct
        });

        // Build filter for products
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

        sendSSE('step', {
            step: 'products',
            status: 'running',
            message: 'Fetching products from database...'
        });

        const products = await executeMongoFind(
            {
                collection: 'ept_product_details_new_sangeetha_mobiles',
                cmpid
            },
            filter,
            { _id: 0 }
        );

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
            message: `Found ${products.length} products in source collection`,
            count: products.length
        });

        // Fetch existing products from main collection for matching
        sendSSE('step', {
            step: 'matching',
            status: 'running',
            message: 'Matching products with main product collection...'
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
            {
                _id: 0,
                product_ean_id: 1,
                product_code: 1
            }
        );

        // Build a Set of existing product keys
        const productMap = new Set();
        if (Array.isArray(existingProducts)) {
            existingProducts.forEach(row => {
                const key = `${row.product_ean_id}_${row.product_code}`;
                productMap.add(key);
            });
        }

        // Filter products to scrape
        const productsToScrape = [];
        products.forEach(product => {
            const productId = product[`${companyId}_product_id`];
            const productCode = product[`${companyId}_product_code`];
            const productUrl = product.product_url;

            if (!productUrl) return;

            const key = `${productId}_${productCode}`;
            if (!productMap.has(key)) return;

            if (!productUrl.toLowerCase().startsWith('https://www.sangeethamobiles.com/product-details/')) return;

            productsToScrape.push(product);
        });

        if (productsToScrape.length === 0) {
            sendSSE('complete', {
                status: true,
                message: 'Active Products Not Found',
                totalProcessed: 0,
                data: []
            });
            return res.end();
        }

        sendSSE('filtered_products', {
            message: `Found ${productsToScrape.length} products to scrape`,
            count: productsToScrape.length
        });

        const ScrapingProductCount = productsToScrape.length;
        const startTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
        const cronStarttime = getCurrentIndTimeInfo();

        // Update cron start time if not single product
        if (!isSingleProduct) {
            await updateStartTimeInDb(cmpid, companyId, CRON_NAME, ScrapingProductCount);
        }

        let productCount = 0;
        const scrapedData = [];

        // Process each product
        for (const product of productsToScrape) {
            productCount = await processProduct(
                product,
                companyId,
                pincode,
                sendSSE,
                scrapedData,
                productCount,
                ScrapingProductCount,
                cmpid,
                isSingleProduct,
                cronStarttime
            );
        }

        // Calculate total time
        const endTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
        const diffMs = endTime - startTime;
        const totalMins = +(diffMs / 60000).toFixed(2);

        // Update cron end time if not single product
        if (!isSingleProduct) {
            await updateEndTimeInDb(
                productCount,
                'ending',
                cmpid,
                companyId,
                totalMins,
                CRON_NAME,
                cronStarttime,
                ScrapingProductCount
            );
        }

        sendSSE('complete', {
            status: true,
            message: 'sangeethamobiles scraping completed',
            totalProcessed: productCount,
            totalProducts: ScrapingProductCount,
            totalMins,
            data: scrapedData
        });

        return res.end();

    } catch (error) {
        console.error('sangeethamobiles scraper fatal error:', error);
        sendSSE('error', {
            status: false,
            message: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
        return res.end();
    }
}

module.exports = {
    sangeethamobilesScraper
};