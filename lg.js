const puppeteer = require('puppeteer');

const { executeMongoFind, executeMongoCount, executeMongoUpdate } = require('./mongo');
const { getCurrentIndTimeInfo, updateStartTimeInDb, updateEndTimeInDb } = require('./utils/cronTime');
const { updatePriceChangeData } = require('./utils/priceChange');
const cronName = 'lg';

async function lgScraper(req, res) {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    
    // Setup SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Function to send SSE events
    const sendSSE = (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        res.flush && res.flush();
    };

    let browser;

    try {
        const cmpid = req.query.cmpid;

        if (!cmpid) {
            sendSSE('error', { message: 'cmpid is required' });
            return res.end();
        }

        const companyId = cmpid.replace('plm_user_info_', '');
        const ean = req.query.ean;
        const itemcode = req.query.itemcode;

        sendSSE('start', { 
            message: 'Scraping started',
            cmpid,
            companyId,
            isSingleProduct: !!(ean && itemcode)
        });

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ]
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        );

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

        sendSSE('fetching', { message: 'Fetching products from database...' });

        const products = await executeMongoFind(
            {
                collection: 'ept_product_details_new_lg',
                cmpid
            },
            filter,
            { _id: 0 }
        );

        if (products.length > 0) {
            sendSSE('products_found', { 
                message: `Found ${products.length} products in source collection`,
                count: products.length 
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
                const key = `${arrTmp[`${companyId}_product_id`]}_${arrTmp[`${companyId}_product_code`]}`;

                if (productMap.has(key) && arrTmp['product_url'].includes('https://www.lg.com/in/')) {
                    ArrGetProductInfo.push(arrTmp);
                }
            });

            if (ArrGetProductInfo.length > 0) {
                sendSSE('filtered_products', {
                    message: `Found ${ArrGetProductInfo.length} products to scrape`,
                    count: ArrGetProductInfo.length
                });

                const ScrapingProductCount = ArrGetProductInfo.length;
                const startTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
                const cronStarttime = getCurrentIndTimeInfo();

                if (!isSingleProduct) {
                    await updateStartTimeInDb(cmpid, companyId, cronName, ScrapingProductCount);
                }

                let productCount = 0;
                const scrapedData = [];

                for (const product of ArrGetProductInfo) {
                    const productUrl = product.product_url;
                    const hostname = new URL(productUrl).hostname;

                    // Send progress event for each product
                    sendSSE('progress', {
                        current: productCount + 1,
                        total: ScrapingProductCount,
                        product_id: product[`${companyId}_product_id`],
                        product_code: product[`${companyId}_product_code`],
                        url: productUrl,
                        percentage: Math.round(((productCount + 1) / ScrapingProductCount) * 100)
                    });

                    if (hostname.includes('lg')) {
                        try {
                            await page.goto(productUrl, {
                                waitUntil: 'networkidle2',
                                timeout: 50000
                            });

                            let varProductPrice;
                            let varProductStock;
                            let varProductImage;
                            let scrapeStatus;
                            let modifiedDate;
                            let varProductReview;
                            let varProductRating;

                            if (await page.$('div.js-print-pdp') === null) {
                                
                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                varProductReview = 'No Result';
                                varProductRating = 'No Result';
                                scrapeStatus = 'pending';

                                sendSSE('product_failed', {
                                    product_id: product[`${companyId}_product_id`],
                                    product_code: product[`${companyId}_product_code`],
                                    reason: 'Product page structure not found'
                                });
                            } else {
                                const result = await page.evaluate(() => {
                                    const productschema = document.querySelector('#pdp-product-schema');

                                    if (!productschema) {
                                        console.log("Product JSON not found or JSON.parse failed.");
                                        return null;
                                    }

                                    const productData = JSON.parse(productschema.textContent);
                                    const reviewCount = document.querySelector('div.bv_numReviews_text').textContent;
                                    const ratingValue = document.querySelector('div.bv_avgRating_component_container').textContent;
                                    const productimage = `https://www.lg.com${productData.image}`;

                                    let stockstatus;
                                    if (!productData.offers) {
                                        stockstatus = 'outofstock';
                                    }

                                    return {
                                        price: productData.offers?.price || '',
                                        availability: productData.offers?.availability || stockstatus || '',
                                        image: productimage || '',
                                        review: reviewCount || 0,
                                        rating: ratingValue || 0
                                    };
                                });

                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                varProductReview = 'No Result';
                                varProductRating = 'No Result';
                                scrapeStatus = 'pending';

                                if (result !== null) {
                                    const status = (result.availability || '').toLowerCase().trim();
                                    varProductImage = result.image || 'No Result';

                                    const cleanedreview = (result.review || '').replace(/[^0-9.]/g, '');
                                    varProductReview = parseFloat(cleanedreview) || 0;
                                    varProductRating = parseFloat(result.rating) || 0;
                                    const cleanedPrice = result.price || '';

                                    if ((status.includes('instock')) && (cleanedPrice > 0)) {
                                        varProductPrice = parseFloat(cleanedPrice);
                                        varProductStock = 'In stock';
                                    } else if (status.includes('outofstock') || status.includes('currently unavailable')) {
                                        varProductStock = 'Out Of Stock';
                                    }
                                    scrapeStatus = 'completed';
                                }
                            }

                            modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

                            updatePriceChangeData(
                                scrapeStatus,
                                product.product_price,
                                varProductPrice,
                                product[`${companyId}_product_id`],
                                product[`${companyId}_product_code`],
                                cronName,
                                cmpid,
                                companyId,
                            );

                            await executeMongoUpdate(
                                {
                                    collection: 'ept_product_details_new_lg',
                                    cmpid
                                },
                                {
                                    [`${companyId}_product_id`]: product[`${companyId}_product_id`],
                                    [`${companyId}_product_code`]: product[`${companyId}_product_code`]
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

                            const scrapedItem = {
                                product_ean_id: product[`${companyId}_product_id`],
                                product_code: product[`${companyId}_product_code`],
                                product_price: varProductPrice,
                                product_stock: varProductStock,
                                modified_date: modifiedDate
                            };

                            scrapedData.push(scrapedItem);
                            productCount++;

                            // Send product scraped event
                            sendSSE('product_scraped', {
                                ...scrapedItem,
                                scrape_status: scrapeStatus,
                                progress: {
                                    current: productCount,
                                    total: ScrapingProductCount,
                                    percentage: Math.round((productCount / ScrapingProductCount) * 100)
                                }
                            });

                            if (!isSingleProduct) {
                                await updateEndTimeInDb(productCount, 'running', cmpid, companyId, null, cronName, cronStarttime, ScrapingProductCount);
                            }

                        } catch (error) {
                            console.error(`Error scraping product ${product[`${companyId}_product_id`]}`);
                            console.error(error);

                            sendSSE('product_error', {
                                product_id: product[`${companyId}_product_id`],
                                product_code: product[`${companyId}_product_code`],
                                error: error.message
                            });
                        }
                    } else {
                        sendSSE('warning', {
                            message: 'Only LG URLs supported',
                            url: productUrl
                        });
                    }
                }

                const endTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
                const diffMs = endTime - startTime;
                const totalMins = +(diffMs / 60000).toFixed(2);

                if (!isSingleProduct) {
                    await updateEndTimeInDb(productCount, 'ending', cmpid, companyId, totalMins, cronName, cronStarttime, ScrapingProductCount);
                }

                // Send completion event
                sendSSE('complete', {
                    message: 'Scraping completed',
                    totalProcessed: productCount,
                    totalMins,
                    data: scrapedData
                });

                return res.end();

            } else {
                sendSSE('complete', {
                    message: 'Active Products Not Found',
                    data: []
                });
                return res.end();
            }
        } else {
            sendSSE('complete', {
                message: 'Products Not Found',
                data: []
            });
            return res.end();
        }
    } catch (error) {
        sendSSE('error', {
            message: error.message,
            stack: error.stack
        });
        return res.end();
    } finally {
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
        }
    }
};

module.exports = { lgScraper };