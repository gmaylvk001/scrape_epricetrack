const puppeteer = require('puppeteer');

const { executeMongoFind, executeMongoCount, executeMongoUpdate } = require('./mongo');
const { getCurrentIndTimeInfo, updateStartTimeInDb, updateEndTimeInDb } = require('./utils/cronTime');
const { updatePriceChangeData } = require('./utils/priceChange');
const cronName = 'vasanth_co';

async function vasanth_coScraper(req, res) {
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
                collection: 'ept_product_details_new_vasanth_co',
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

                if (productMap.has(key) && arrTmp['product_url'].includes('https://vasanthandco.in/')) {
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
            
                for (const product of ArrGetProductInfo) {
                    // console.log(product.product_url); return false;
                    const productUrl = product.product_url;
                    //const productUrl = "https://vasanthandco.in/product/132172100742/butterfly-standard-plus-7-5-litre-aluminium-cooker";
                    const hostname = new URL(productUrl).hostname;
                    // console.log(productUrl);

                    // vasanth_co
                    if (hostname.includes('vasanthandco')) {
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

                            if(await page.$('.product.product-single.row') === null) {
                                //console.log('No product title found');
                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                scrapeStatus = 'pending';
                            }
                            else{
                                const result = await page.evaluate(() => {
                                    const json = document.querySelector('script[type="application/ld+json"]').textContent;

                                    let jsondata;

                                    try {
                                        jsondata = JSON.parse(json);
                                    } catch (e) {
                                        try {
                                            const fixed = json.replace(
                                                /"([^"\\]*(?:\\.[^"\\]*)*)"/gs,
                                                str => str
                                                    .replace(/\r/g, "\\r")
                                                    .replace(/\n/g, "\\n")
                                            );

                                            jsondata = JSON.parse(fixed);
                                        } catch {
                                            return null;
                                        }
                                    }

                                    const product = jsondata['@graph'].find(item => item['@type'] == 'Product');

                                    // return product;

                                    if (!product) {
                                        console.log("Product JSON not found or JSON.parse failed.");
                                        return null;
                                    }

                                    return {
                                        price: product.offers?.price || '',
                                        availability: product.offers?.availability || '',
                                        image: product.image?.[0] || ''
                                    };
                                });

                                // console.log(result);
                                //console.log(product[`${companyId}_product_id`]);
                                
                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                scrapeStatus = 'pending';

                                if (result !== null) {
                                    const status = (result.availability || '').toLowerCase().trim();

                                    varProductImage = result.image || 'No Result';
                                    const cleanedPrice = (result.price || '').replace(/[^0-9.]/g, '');

                                    if ((status.includes('instock')) && (cleanedPrice > 0)) {
                                        varProductPrice = parseFloat(cleanedPrice);
                                        varProductStock = 'In stock';
                                    }
                                    else if(status.includes('outofstock') || status.includes('currently unavailable')){
                                        varProductStock = 'Out Of Stock';
                                    }
                                    scrapeStatus = 'completed';
                                } 
                            }

                            modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

                            updatePriceChangeData(scrapeStatus,product.product_price,varProductPrice,product[`${companyId}_product_id`],product[`${companyId}_product_code`],cronName,cmpid,companyId,);

                            await executeMongoUpdate(
                                {
                                    collection: 'ept_product_details_new_vasanth_co',
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
                                        product_review: 'No Result',
                                        product_rating: 'No Result'
                                    }
                                }
                            );

                            productCount++;
                            
                            if (!isSingleProduct) {
                                await updateEndTimeInDb(productCount, 'running', cmpid, companyId, null, cronName, cronStarttime, ScrapingProductCount);
                            }
                        }
                        catch (error) {
                            console.error(`Error scraping product ${product[`${companyId}_product_id`]}`);
                            console.error(error);
                        }
                    }

                    else {
                        console.log(`${companyId}_product_id`);
                        console.log(productUrl);
                        return res.status(400).json({
                            status: false,
                            message: 'Only vasanth and co URLs supported'
                        });

                    }
                    //break;
                    //res.json(result); 
                    //console.log(product[`${companyId}_product_id`]);
                    //return(product[`${companyId}_product_id`]);
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

module.exports = { vasanth_coScraper };