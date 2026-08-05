const express = require('express');
const puppeteer = require('puppeteer');
require('dotenv').config({ quiet: true });

const { executeMongoFind } = require('./mongo');

const app = express();

app.get('/mongo/products', async (req, res) => {
    try {
        const cmpid = req.query.cmpid;

        if (!cmpid) {
            return res.status(400).json({
                status: false,
                message: 'cmpid is required'
            });
        }

        const products = await executeMongoFind(
            {
                collection: 'ept_product_details_new_amazon',
                cmpid
            },
            {
                $and: [
                    { status: 'active' },
                    { product_scrape_status: { $in: ['pending', 'completed'] } },
                    { product_url: { $nin: ['', null, 'No Result'] } }
                ]
            },
            { _id: 0 }
        );

        res.json({
            status: true,
            data: products
        });
    } catch (error) {
        res.status(500).json({
            status: false,
            message: error.message
        });
    }
});

const scrapeProduct = async (req, res) => {
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const productUrl = req.query.url;

    if (!productUrl) {
        return res.status(400).json({
            status: false,
            message: 'URL is required'
        });
    }

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

        await page.goto(productUrl, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        const hostname = new URL(productUrl).hostname;

        let product = {};

        // AMAZON
        if (hostname.includes('amazon')) {

            await page.waitForSelector('#productTitle');

            product = await page.evaluate(() => {

                const getText = (selector) => {
                    const el = document.querySelector(selector);
                    return el ? el.textContent.trim() : '';
                };

                const getAttr = (selector, attr) => {
                    const el = document.querySelector(selector);
                    return el ? el.getAttribute(attr) : '';
                };

                return {
                    name: getText('#productTitle'),
                    brand: getText('#bylineInfo'),
                    price: getText('.a-price .a-offscreen'),
                    availability:
                    getText('#availability .a-color-success') ||
                    getText('#availability span') ||
                    getText('#availability'),
                    image: getAttr('#landingImage', 'src')
                };
            });

        }

        // FLIPKART
        else if (hostname.includes('flipkart')) {

            await page.waitForSelector('h1');

            product = await page.evaluate(() => {

                const jsonLd = document.querySelector('#jsonLD');

                if (!jsonLd) {
                    return null;
                }

                const data = JSON.parse(jsonLd.textContent)[0];

                return {
                    //data: data,
                    name: data.name || '',
                    brand: data.brand?.name || '',
                    price: data.offers?.price
                        ? `₹${data.offers.price}`
                        : '',
                    availability: data.offers?.availability || '',    
                    image: Array.isArray(data.image)
                        ? data.image[0]
                        : data.image || ''
                };
                {/*
                const getText = (selector) => {
                    const el = document.querySelector(selector);
                    return el ? el.innerText.trim() : '';
                };

                const getAttr = (selector, attr) => {
                    const el = document.querySelector(selector);
                    return el ? el.getAttribute(attr) : '';
                };

                const title =
                    getText('span.VU-ZEz') ||
                    getText('h1');

                let brand = '';

                if (title) {
                    brand = title.split(' ')[0];
                }

                const image =
                    getAttr('img._396cs4', 'src') ||
                    getAttr('img.DByuf4', 'src') ||
                    getAttr('img', 'src');

                const price =
                    getText('div.Nx9bqj') ||
                    getText('div._30jeq3') ||
                    getText('[class*="Nx9bqj"]') ||
                    getText('[class*="_30jeq3"]');

                return {
                    name: title,
                    brand: brand,
                    price: price,
                    image: image
                };
                */}
            });

        } // CROMA
        else if (hostname.includes('croma.com')) {
            await page.waitForSelector(
                'script[type="application/ld+json"], [class*="pd-title-normal"], .pd-title-normal',
                { timeout: 30000 }
            );


// Wait page load
await delay(3000);
try {

   
    // Wait popup
    await page.waitForSelector('.pinElem', {
        visible: true,
        timeout: 15000
    });

    // Focus input
    await page.click('.pinElem');

    // Clear existing value
    await page.evaluate(() => {

        const input = document.querySelector('.pinElem');

        input.focus();

        input.value = '';

        input.dispatchEvent(new Event('input', {
            bubbles: true
        }));

    });

    // Select all + delete
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');

    await page.keyboard.press('Backspace');

    // Type pincode
    await page.type('.pinElem', '400001', {
        delay: 120
    });

    // Small delay
   await delay(3000);

    // Click Continue
    await page.click('#apply-pincode-btn');

    // Wait popup closed
    await page.waitForFunction(() => {
        return !document.querySelector('.MuiDialog-root');
    }, {
        timeout: 30000
    });

    // Wait network finished
    await page.waitForNetworkIdle({
        idleTime: 2000,
        timeout: 30000
    });

    // Extra wait for React rendering
    await delay(3000);

    console.log("Pincode updated successfully.");

} catch (err) {

    console.log("Unable to set pincode:", err.message);

}
            

            product = await page.evaluate(() => {
                const getText = (selector) =>
                    document.querySelector(selector)?.textContent?.trim() || null;

                const getImage = (selector) =>
                    document.querySelector(selector)?.currentSrc ||
                    document.querySelector(selector)?.src ||
                    null;

                const getMeta = (name) => {
                    const el = document.querySelector(
                        `meta[property="${name}"], meta[name="${name}"]`
                    );

                    return el?.getAttribute('content') || null;
                };

                let productData = null;

                document
                    .querySelectorAll('script[type="application/ld+json"]')
                    .forEach((script) => {
                        try {
                            const json = JSON.parse(script.textContent);

                            if (
                                json['@type'] === 'Product' ||
                                (Array.isArray(json['@graph']) &&
                                    json['@graph'].some(
                                        (item) => item['@type'] === 'Product'
                                    ))
                            ) {
                                productData = json;
                            }
                        } catch (e) {}
                    });

                let productNode = productData;

                if (productData?.['@graph']) {
                    productNode = productData['@graph'].find(
                        (item) => item['@type'] === 'Product'
                    );
                }

                const offers = productNode?.offers || {};
                const jsonLdImage = Array.isArray(productNode?.image)
                    ? productNode.image[0]
                    : productNode?.image;
                const name =
                    productNode?.name ||
                    getText('[class*="pd-title-normal"]') ||
                    getText('.pd-title-normal') ||
                    getMeta('og:title')?.replace(/\s+Online\s+-\s+Croma$/i, '');
                const productImage = [...document.querySelectorAll('img')]
                    .map((img) => img.currentSrc || img.src)
                    .find((src) =>
                        src &&
                        !src.startsWith('data:') &&
                        !/Croma_Logo|bat\.bing/i.test(src)
                    );

                   const availability =
                        (offers?.availability?.includes('InStock') && 'In Stock') ||
                        (offers?.availability?.includes('OutOfStock') && 'Out Of Stock') ||
                        getText('[class*="stock"]') ||
                        getText('[class*="availability"]') ||
                        getText('[class*="delivery"]') ||
                        getText('[class*="pincode"]') ||
                        null;

                        const debugAvailability = [...document.querySelectorAll('*')]
                        .map(el => el.textContent?.trim())
                        .filter(text =>
                            text &&
                            (
                                text.includes('In Stock') ||
                                text.includes('Out of Stock') ||
                                text.includes('Available') ||
                                text.includes('Not Available') ||
                                text.includes('Deliver')
                            )
                        );

                        let stockStatus = null;

                    document.querySelectorAll('script').forEach(script => {
                        const txt = script.textContent || '';

                        if (txt.includes('InStock')) {
                            stockStatus = 'In Stock';
                        }

                        if (txt.includes('OutOfStock')) {
                            stockStatus = 'Out Of Stock';
                        }
                    });

                return {
                    name,

                    brand:
                        productNode?.brand?.name ||
                        productNode?.brand ||
                        getText('.cp-product-brand') ||
                        getText('[data-testid="brand-name"]') ||
                        name?.split(/\s+/)[0] ||
                        null,

                    price:
                        (offers?.price
                            ? `\u20b9${Number(offers.price).toLocaleString('en-IN')}`
                            : null) ||
                        getText('#pdp-product-price') ||
                        getText('.new-price'),

                    image:
                        jsonLdImage ||
                        getMeta('og:image') ||
                        getMeta('twitter:image') ||
                        getMeta('image') ||
                        getImage('img.product-image') ||
                        productImage ||
                        getImage('img'),

                        availability: stockStatus || availability || 'Unknown'
                };
            });
        }
        // RELIANCE DIGITAL
        else if (
            hostname.includes('reliancedigital.in')
        ) {

            await page.waitForSelector(
                'script[type="application/ld+json"]',
                { timeout: 30000 }
            );

            product = await page.evaluate(() => {

                const result = {
                    name: '',
                    brand: '',
                    price: '',
                    image: ''
                };

                const scripts = document.querySelectorAll(
                    'script[type="application/ld+json"]'
                );

                for (const script of scripts) {

                    try {

                        const json = JSON.parse(script.textContent);

                        const items = Array.isArray(json)
                            ? json
                            : [json];

                        for (const item of items) {

                            if (
                                item['@type'] === 'Product' ||
                                (item.name && item.offers)
                            ) {

                                result.name = item.name || '';

                                result.brand =
                                    typeof item.brand === 'object'
                                        ? item.brand.name
                                        : item.brand || '';

                                result.price =
                                    item.offers?.price
                                        ? `₹${item.offers.price}`
                                        : '';
                                result.availability =
                                    item.offers?.availability
                                        ? `₹${item.offers.availability}`
                                        : '';        

                                result.image =
                                    Array.isArray(item.image)
                                        ? item.image[0]
                                        : item.image || '';

                                return result;
                            }
                        }

                    } catch (e) {}
                }

                // Fallback selectors
                result.name =
                    document.querySelector('h1')?.innerText || '';

                result.price =
                    document.querySelector(
                        '[data-testid="price"]'
                    )?.innerText ||
                    '';

                result.image =
                    document.querySelector('img')?.src || '';

                return result;
            });
        }
        // VIJAY SALES
        else if (hostname.includes('vijaysales.com')) {

            await page.waitForSelector(
                'script[type="application/ld+json"]',
                { timeout: 30000 }
            );

            product = await page.evaluate(() => {

                const result = {
                    name: '',
                    brand: '',
                    price: '',
                    image: ''
                };

                

                // Try JSON-LD first
                const scripts = document.querySelectorAll(
                    'script[type="application/ld+json"]'
                );

                result.image =
                    document.querySelector('#gfg-img')?.src ||
                    document.querySelector('.carousel__currentImage')?.src ||
                    document.querySelector('meta[property="og:image"]')?.content ||
                    '';

                for (const script of scripts) {

                    try {

                        const json = JSON.parse(script.textContent);

                        const items = Array.isArray(json)
                            ? json
                            : [json];


                        for (const item of items) {

                            if (
                                item['@type'] === 'Product' ||
                                (item.name && item.offers)
                            ) {

                               

                                return {
                                    name: item.name || '',
                                    brand:
                                        typeof item.brand === 'object'
                                            ? item.brand.name
                                            : item.brand || '',
                                    price:
                                        item.offers?.price
                                            ? `₹${item.offers.price}`
                                            : '',
                                    availability: item.offers?.availability || '',
                                    image:
                                         result.image || ''
                                };
                            }
                        }

                    } catch (e) {}
                }

                // Fallback to meta tags
                result.name =
                    document.querySelector('meta[property="og:title"]')
                        ?.content ||
                    document.querySelector('h1')
                        ?.innerText ||
                    '';

                
                    result.image =
                    document.querySelector('#gfg-img')?.src ||
                    document.querySelector('.carousel__currentImage')?.src ||
                    document.querySelector('meta[property="og:image"]')?.content ||
                    '';

                result.price =
                    document.querySelector('meta[property="product:price:amount"]')
                        ?.content ||
                    '';

                // Brand from first word
                if (result.name) {
                    result.brand = result.name.split(' ')[0];
                }

                return result;
            });
        }
        else {

            return res.status(400).json({
                status: false,
                message: 'Only Amazon, Flipkart, Croma, Reliance Digital and Vijay Sales URLs supported'
            });

        }

        res.json(product);

    } catch (error) {

        res.status(500).json({
            status: false,
            message: error.message
        });

    } finally {

        if (browser) {
            await browser.close();
        }

    }

};

module.exports = { scrapeProduct };