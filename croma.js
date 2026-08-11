const puppeteer = require('puppeteer');

const { executeMongoFind, executeMongoCount, executeMongoUpdate } = require('./mongo');
const { getCurrentIndTimeInfo, updateStartTimeInDb, updateEndTimeInDb } = require('./utils/cronTime');
const { updatePriceChangeData } = require('./utils/priceChange');
const cronName = 'croma';

async function cromaScraper(req, res) {
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
                collection: 'ept_product_details_new_croma',
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

                if (productMap.has(key) && arrTmp['product_url'].includes('https://www.croma.com/')) {
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

                try{
                    const productUrltest = "https://www.croma.com/";

                    await page.goto(productUrltest, {
                        waitUntil: 'networkidle2',
                        timeout: 50000
                    });

                    await delay(3000);
                    if(await page.$('.pinElem') === null) {
                        console.log('croma pincode popup not found, continuing...');
                    }
                    else{
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
                        },{
                            timeout: 30000
                        });

                        // console.log("MuiDialog display is now 'none' (or dialog removed).");

                        // Wait for page/network update
                        await page.waitForNetworkIdle({
                            idleTime: 2000,
                            timeout: 50000
                        });

                        await delay(2000);
                    }
                }catch(err){
                    console.log("Unable to set pincode:", err.message);
                }

                let productCount = 0;
                const scrapedData = [];

                for (const product of ArrGetProductInfo) {
                    //console.log(product.product_url);
                    const productUrl = product.product_url;
                    // const productUrl = "https://www.croma.com/bosch-series-6-14-place-settings-free-standing-dishwasher-with-glass-protection-technology-no-pre-rinse-required-silver-/p/314620";
                    const hostname = new URL(productUrl).hostname;
                    //console.log(productUrl);

                    let result = {};

                    // CROMA
                    if (hostname.includes('croma')) {
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

                            if(await page.$('.pd-title-normal') === null) {
                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                varProductReview = 'No Result';
                                varProductRating = 'No Result';
                                scrapeStatus = 'pending';
                            }
                            else{
                                await page.waitForSelector(
                                    'script[type="application/ld+json"], [class*="pd-title-normal"], .pd-title-normal',
                                    { timeout: 30000 }
                                );

                                const result = await page.evaluate(() => {
                                    const productData = [...document.querySelectorAll('script[type="application/ld+json"]')]
                                    .map(script => {
                                        let text = script.textContent.trim();
                                        try{
                                            return JSON.parse(text);
                                        }
                                        catch(e){
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
                                            }
                                            catch(err){
                                                console.log("JSON-LD Parse Error:", err.message);
                                            }return null;
                                        }
                                    }).find(item => item?.["@type"] === "Product");

                                    const ProductPrice = document.querySelector('#pdp-product-price')?.textContent?.trim();
                                    const StockStatus = ((document.querySelector('span.not-available-color')) || (document.querySelector('span.approvalStatus-span-message'))) ? 'outofstock' : 'instock';

                                    return {
                                        price: ProductPrice || '',
                                        image: productData?.image?.[0] || '',
                                        availability : StockStatus,
                                        review: productData?.aggregateRating?.ratingCount || '0',
                                        rating: productData?.aggregateRating?.ratingValue || '0'
                                    };
                                });

                                //console.log(result);
                                //console.log(product[`${companyId}_product_id`]);

                                varProductPrice = 'No Result';
                                varProductStock = 'No Result';
                                varProductImage = 'No Result';
                                varProductReview = 'No Result';
                                varProductRating = 'No Result';
                                scrapeStatus = 'pending';

                                if (result !== null) {
                                    const status = (result.availability || '').toLowerCase().trim();

                                    varProductReview = parseFloat(result.review) || 0;
                                    varProductRating = (Math.round(parseFloat(result.rating) * 10) / 10) || 0;
                                    varProductImage = result.image || 'No Result';
                                    const cleanedPrice = (result.price || '').replace(/[^0-9.]/g, '');
                                    scrapeStatus = 'completed';

                                    if ((status === 'instock') && (cleanedPrice > 0)) {
                                        varProductPrice = parseFloat(cleanedPrice) || 'No Result';
                                        varProductStock = 'In stock';
                                    }
                                    else if(status.includes('outofstock') || status.includes('currently unavailable')){
                                        varProductStock = 'Out Of Stock';
                                    }
                                }
                            }

                            modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');
                                    
                            updatePriceChangeData(scrapeStatus,product.product_price,varProductPrice,product[`${companyId}_product_id`],product[`${companyId}_product_code`],cronName,cmpid,companyId,);

                            await executeMongoUpdate(
                                {
                                    collection: 'ept_product_details_new_croma',
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

                            scrapedData.push({
                                product_ean_id: product[`${companyId}_product_id`],
                                product_code: product[`${companyId}_product_code`],
                                product_price: varProductPrice,
                                product_stock: varProductStock,
                                modified_date: modifiedDate
                            });

                            productCount++;
                            
                            if (!isSingleProduct) {
                                await updateEndTimeInDb(productCount, 'running', cmpid, companyId, null, cronName, cronStarttime, ScrapingProductCount);
                            }

                            /* console.log(product[`${companyId}_product_id`]);
                            return res.status(200).json({
                                status: true,
                                data: product[`${companyId}_product_id`]
                            }); */
                        }
                        catch (error) {
                            console.error(`Error scraping product ${product[`${companyId}_product_id `]}`);
                            console.error(error);
                        }
                    }
                    else{
                        return res.status(400).json({
                            status: false,
                            message: 'Only Croma URLs supported'
                        });
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
                    totalProcessed: productCount,
                    data : scrapedData
                });
            }
            else{

            }
        }
        else{
            return res.status(200).json({
                status: true,
                message: "Products Not Found"
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

module.exports = { cromaScraper };