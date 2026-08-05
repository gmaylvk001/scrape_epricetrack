const puppeteer = require('puppeteer');

const { executeMongoFind, executeMongoCount, executeMongoUpdate } = require('./mongo');
const { getCurrentIndTimeInfo, updateStartTimeInDb, updateEndTimeInDb } = require('./utils/cronTime');
const { updatePriceChangeData } = require('./utils/priceChange');
const cronName = 'sathya';

async function sathyaScraper(req, res) {
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    /*
    const productUrl = req.query.url;

    if (!productUrl) {
        return res.status(400).json({
            status: false,
            message: 'URL is required'
        });
    }
    */
    let browser;

    try {

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
              //  '--proxy-server=http://31.59.20.176:6754'
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
                collection: 'ept_product_details_new_sathya',
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
                        { status: 'active' },
                        {ean_product_data_details_scrap_status : 'completed'}
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

                if (productMap.has(key) && arrTmp['product_url'].includes('https://www.sathya.store/')) {
                    ArrGetProductInfo.push(arrTmp);
                }
            });

            if(ArrGetProductInfo.length > 0){
                const ScrapingProductCount = ArrGetProductInfo.length;
                const startTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
                const cronStarttime = getCurrentIndTimeInfo();

                if (!isSingleProduct) {
                    await updateStartTimeInDb(cmpid, companyId, cronName, ScrapingProductCount);
                }

                let productCount = 0;

                const apiUrl = "https://www.sathya.store/apis/sathya_full_active_data?api_token=cad5f0e2c7991324c616c0a52b667e3b07425c85ee8d9f26e1b7b504c18dfe91";

                const response = await fetch(apiUrl);
                const apiproducts = await response.json();
            
                for (const product of ArrGetProductInfo) {
                    // console.log(product.product_url); return false;
                    const unspliteURL = product.product_url;
                    const productUrl = unspliteURL.split("?")[0];
                    const sathyaProduct = apiproducts.find(item => item.product_url === productUrl);
                    //const productUrl = "https://www.sathya.store/category/mobiles/iphone/apple-iphone-17-pro-512gb-silver-ip17pro512silmg8k4";
                    const hostname = new URL(productUrl).hostname;
 
                    //sathya
                    let varProductPrice;
                    let varProductStock;
                    let varProductImage;
                    let scrapeStatus;
                    let modifiedDate;
                    let varProductReview;
                    let varProductRating;

                    if(sathyaProduct){
                        try {
                            await page.goto(productUrl, {
                                waitUntil: 'networkidle2',
                                timeout: 50000
                            });

                            varProductImage = sathyaProduct.product_image;
                            const lspcleanedPrice = (sathyaProduct.lsp_price).replace(/[^0-9.]/g, '');
                            let cleanedPrice;
                            if(lspcleanedPrice > 0){
                                cleanedPrice = lspcleanedPrice;
                            }
                            else{
                                cleanedPrice = (sathyaProduct.price).replace(/[^0-9.]/g, '');
                            }
                            const status = (sathyaProduct.stock_status).toLowerCase().trim();

                            if ((status.includes('in stock')) && (cleanedPrice > 0)) {
                                varProductPrice = parseFloat(cleanedPrice);
                                varProductStock = 'In stock';
                            } 
                            else if(status.includes('out of stock') || status.includes('currently unavailable')){
                                varProductStock = 'Out Of Stock';
                            }
                            scrapeStatus = 'completed';
                            
                            const result = await page.evaluate(() => {
                                const text = document.querySelector("div.rating-section h6")?.textContent?.trim();

                                const match = text?.match(/^([\d.]+)\s*\((\d+)\s*Reviews?\)$/);

                                const ratingValue = match?.[1] || "0";
                                const reviewCount = match?.[2] || "0";

                                return {
                                    review: reviewCount || 0,
                                    rating: ratingValue || 0
                                };
                            });

                            varProductReview = result.review;
                            varProductRating = result.rating;
                        }
                        catch (error) {
                            console.error(`Error scraping product ${product[`${companyId}_product_id`]}`);
                            console.error(error);
                        }
                    }
                    else{
                        varProductPrice = 'No Result';
                        varProductStock = 'No Result';
                        varProductImage = 'No Result';
                        varProductReview = 'No Result';
                        varProductRating = 'No Result';
                        scrapeStatus = 'pending';
                    }
                    
                    modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

                    updatePriceChangeData(scrapeStatus,product.product_price,varProductPrice,product[`${companyId}_product_id`],product[`${companyId}_product_code`],cronName,cmpid,companyId,);

                    await executeMongoUpdate(
                        {
                            collection: 'ept_product_details_new_sathya',
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
                                modified_date: modifiedDate,
                                product_scrape_status: scrapeStatus,
                                product_review: varProductReview,
                                product_rating: varProductRating
                            }
                        }
                    );

                    productCount++;
                    
                    if (!isSingleProduct) {
                        await updateEndTimeInDb(productCount, 'running', cmpid, companyId, null, cronName, cronStarttime, ScrapingProductCount);
                    }
                    
                };

                const endTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);

                const diffMs = endTime - startTime;
                const totalMins = +(diffMs / 60000).toFixed(2);

                if (!isSingleProduct) {
                    await updateEndTimeInDb(productCount, 'ending', cmpid, companyId, totalMins, cronName, cronStarttime, ScrapingProductCount);
                }

                return res.status(200).json({
                    status: true,
                    message: "Scraping completed",
                    totalProcessed: productCount
                });
            }
            else{
                return res.status(200).json({
                    status: true,
                    message: "Active Products Not Found"
                });
            }
        }
        else{
            return res.status(200).json({
                status: true,
                message: "Products Not Found"
            });
        }
    } 
    catch(error){
        res.status(500).json({
            status: false,
            message: error.message
        });
    }
    finally{
        if (browser) {
            console.log('Closing browser...');
            await browser.close();
        }
    }
};

module.exports = {sathyaScraper };