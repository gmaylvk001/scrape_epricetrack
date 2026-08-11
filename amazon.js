const puppeteer = require('puppeteer');
const { executeMongoFind, executeMongoCount, executeMongoUpdate } = require('./mongo');
const { getCurrentIndTimeInfo, updateStartTimeInDb, updateEndTimeInDb } = require('./utils/cronTime');
const { updatePriceChangeData } = require('./utils/priceChange');
const cronName = 'amazon';

async function amazonScraper(req, res) {
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    let browser;

    try {

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                /*'--proxy-server=http://31.59.20.176:6754'*/
            ]
        });

        const page = await browser.newPage();

        /*
            await page.authenticate({
                username: 'eqenhyym',
                password: 'qsfp3x1obv71'
            });
        */

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        );

        /*
            await page.goto(productUrl, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
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

        const filter = {
            status: 'active',
            product_scrape_status: { $in: ['pending', 'completed'] },
            product_url: { $nin: ['', null, 'No Result'] }
        };

        const isSingleProduct = !!(ean && itemcode);

        if(isSingleProduct){
            filter[`${companyId}_product_id`] = ean;
            filter[`${companyId}_product_code`] = itemcode;
        }

        const products = await executeMongoFind(
            {
                collection: 'ept_product_details_new_amazon',
                cmpid
            },
            filter,
            { _id: 0 }
        );

        if(products.length > 0){

            const existingProducts = await executeMongoFind(
                {
                    collection: 'ept_product_details_new',
                    cmpid
                },
                {
                    $and: [
                        { status: 'active' }
                    ]
                },
                { _id: 0, product_ean_id: 1, product_code: 1 }
            );

            const productMap = new Set();
            existingProducts.forEach((row) => {
                const key = `${row.product_ean_id}_${row.product_code}`;
                productMap.add(key);
            });

            const ArrGetProductInfo = [];
            products.forEach((arrTmp) => {
                const key = `${arrTmp[`${companyId}_product_id`]}_${arrTmp[`${companyId}_product_code`]}`;

                if (productMap.has(key)) {
                    ArrGetProductInfo.push(arrTmp);
                }
            });

            if(ArrGetProductInfo.length > 0){

                let productCount = 0;
                const startTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
                const cronStartTime = getCurrentIndTimeInfo();

                const ScrapingProductCount = ArrGetProductInfo.length;
                if (!isSingleProduct) {
                    await updateStartTimeInDb(cmpid, companyId, cronName, ScrapingProductCount);
                }

                const scrapedData = [];

                for (const product of ArrGetProductInfo) {

                    const productUrl = product.product_url;
                    const hostname = new URL(productUrl).hostname;
                
                    let result = {};
                    if (hostname.includes('amazon')) {

                        try {

                            await page.goto(productUrl, {
                                waitUntil: 'networkidle2',
                                timeout: 50000
                            });

                            let varProductPrice;
                            let varProductStock;
                            let varProductImage;
                            let varProductReview;
                            let varProductRating;
                            let scrapeStatus;
                            let modifiedDate;

                            if(await page.$('#productTitle') === null) {

                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                varProductReview = 'No Result';
                                varProductRating = 'No Result';
                                scrapeStatus = 'pending';

                            }else{

                                const result = await page.evaluate(() => {

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
                            
                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                varProductReview = 'No Result';
                                varProductRating = 'No Result';
                                scrapeStatus = 'pending';

                                if(result !== null){

                                    varProductImage = result.image || 'No Result';
                                    varProductReview = result.review
                                    ? parseFloat(result.review.replace(/[^0-9.]/g, '')) || 0
                                    : 'No Result';
                                    varProductRating = result.rating
                                    ? parseFloat(result.rating.replace(/[^0-9.]/g, '')) || 0
                                    : 'No Result';

                                    if (result.price) {

                                        const priceValue = result.price.match(/[\d,]+(?:\.\d+)?/)?.[0] || '';
                                        const newPrice = parseFloat(priceValue.replace(/,/g, ''));
                                        if(newPrice > 0){
                                            varProductPrice = newPrice;
                                            varProductStock = 'In stock';
                                        }else{
                                            varProductStock = 'Out Of Stock';
                                        }
                                        
                                    }else {
                                        varProductStock = 'Out Of Stock';
                                    }
                                    scrapeStatus = 'completed';
                                }
                            }

                            modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

                            updatePriceChangeData(scrapeStatus,product.product_price,varProductPrice,product[`${companyId}_product_id`],product[`${companyId}_product_code`],cronName,cmpid,companyId,);
                            
                            await executeMongoUpdate(
                                {
                                    collection: 'ept_product_details_new_amazon',
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
                                product_ean_id: product[`${companyId}_product_id`],
                                product_code: product[`${companyId}_product_code`],
                                product_price: varProductPrice,
                                product_stock: varProductStock,
                                modified_date: modifiedDate
                            });

                            productCount++;

                            if (!isSingleProduct) {
                                await updateEndTimeInDb(productCount, 'running', cmpid, companyId, null, cronName, cronStartTime, ScrapingProductCount);
                            }
                            

                        }catch (error) {
                            console.error(`Error scraping product ${product[`${companyId}_product_id `]}`);
                            console.error(error);
                        }
                    }

                    else {

                        return res.status(400).json({
                            status: false,
                            message: 'Only Amazon URLs supported'
                        });

                    }
                };

                const endTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);

                const diffMs = endTime - startTime;
                const totalMins = +(diffMs / 60000).toFixed(2);
                
                if (!isSingleProduct) {
                await updateEndTimeInDb(productCount, 'ending', cmpid, companyId, totalMins, cronName,cronStartTime, ScrapingProductCount);
                }

                return res.status(200).json({
                    status: true,
                    message: "Scraping completed",
                    totalProcessed: productCount,
                    data: scrapedData
                });

            }else{

                return res.status(200).json({
                    status: true,
                    message: "Active Products not found"
                });
            }

        }else{

            return res.status(200).json({
                status: true,
                message: "Competitor Products not found"
            });
        }

    } catch (error) {

        res.status(500).json({
            status: false,
            message: error.message
        });

    } finally {

        if (browser) {
            console.log('Closing browser...');
            await browser.close();
        }

    }

};

module.exports = { amazonScraper };