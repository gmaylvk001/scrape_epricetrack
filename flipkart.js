const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const EventEmitter = require('events');
const {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb
} = require('./utils/cronTime');
const { updatePriceChangeData } = require('./utils/priceChange');
const {
    executeMongoFind,
    executeMongoUpdate
} = require('./mongo');

const cronName = 'flipkart';

// ── Internal logger (emits 'log' events) ─────────────────────
class Logger extends EventEmitter {
    info(msg) { this.emit('log', { level: 'info', message: msg, timestamp: new Date() }); }
    error(msg) { this.emit('log', { level: 'error', message: msg, timestamp: new Date() }); }
    warn(msg) { this.emit('log', { level: 'warn', message: msg, timestamp: new Date() }); }
}
const logger = new Logger();

// Optional: listen to logs (e.g., write to file or debug console)
logger.on('log', (entry) => {
    // You can redirect to a logging service or just console
    console[entry.level]?.(`[${entry.timestamp}] ${entry.message}`);
});

// ── Helper: delay ─────────────────────────────────────────────
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Main scraper ──────────────────────────────────────────────
async function flipkartScraper(req, res) {
    let browser;

    // ── SSE sender ─────────────────────────────────────────────
    const sendEvent = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    };

    // ── Request validation ─────────────────────────────────────
    const cmpid = req.query.cmpid;
    if (!cmpid) {
        return res.status(400).json({ status: false, message: 'cmpid is required' });
    }
    const companyId = cmpid.replace('plm_user_info_', '');
    const ean = req.query.ean;
    const itemcode = req.query.itemcode;
    const isSingleProduct = !!(ean && itemcode);

    // ── SSE headers ─────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // ── Client disconnect ──────────────────────────────────────
    let clientDisconnected = false;
    req.on('close', () => {
        clientDisconnected = true;
        logger.info('Flipkart client disconnected');
    });

    // ── Initial event ──────────────────────────────────────────
    sendEvent('start', {
        status: true,
        message: 'Flipkart scraping started',
        cmpid,
        companyId,
        isSingleProduct
    });

    try {
        // ── Launch browser ──────────────────────────────────────
        logger.info('Launching browser...');
        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
            ],
            timeout: 30000
        });

        // ── Fetch products from DB ──────────────────────────────
        const filter = {
            status: 'active',
            product_scrape_status: { $in: ['pending', 'completed'] },
            product_url: { $nin: ['', null, 'No Result'] }
        };
        if (isSingleProduct) {
            filter[`${companyId}_product_id`] = ean;
            filter[`${companyId}_product_code`] = itemcode;
        }

        const products = await executeMongoFind(
            { collection: 'ept_product_details_new_flipkart', cmpid },
            filter,
            { _id: 0 }
        );

        if (!products || products.length === 0) {
            sendEvent('complete', { status: true, message: 'No products found', totalProcessed: 0, data: [] });
            res.end();
            return;
        }

        // ── Match with active products ──────────────────────────
        const existingProducts = await executeMongoFind(
            { collection: 'ept_product_details_new', cmpid },
            { status: 'active' },
            { _id: 0, product_ean_id: 1, product_code: 1 }
        );
        const productMap = new Set(existingProducts.map(r => `${r.product_ean_id}_${r.product_code}`));

        const productsToScrape = products.filter(p =>
            productMap.has(`${p[`${companyId}_product_id`]}_${p[`${companyId}_product_code`]}`)
        );

        if (productsToScrape.length === 0) {
            sendEvent('complete', { status: true, message: 'No active products found', totalProcessed: 0, data: [] });
            res.end();
            return;
        }

        // ── Initialise scraping ──────────────────────────────────
        const total = productsToScrape.length;
        let processed = 0;
        const scrapedData = [];
        const startTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
        const cronStartTime = getCurrentIndTimeInfo();

        if (!isSingleProduct) {
            await updateStartTimeInDb(cmpid, companyId, cronName, total);
        }

        sendEvent('progress', {
            status: 'running',
            totalProducts: total,
            processedProducts: 0,
            progress: 0,
            message: `${total} products found`
        });

        // ── Scrape each product ──────────────────────────────────
        for (const product of productsToScrape) {
            if (clientDisconnected) break;

            const productUrl = product.product_url;
            const productId = product[`${companyId}_product_id`];
            const productCode = product[`${companyId}_product_code`];
            processed++;

            // Validate URL
            let hostname;
            try {
                hostname = new URL(productUrl).hostname;
            } catch {
                logger.warn(`Invalid URL for product ${productId}`);
                continue;
            }
            if (!hostname.includes('flipkart')) {
                logger.warn(`Non-Flipkart URL for ${productId}`);
                continue;
            }

            // ── Per‑product page ──────────────────────────────────
            const page = await browser.newPage();

            // Setup interception and headers
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
                'Sec-Ch-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'Sec-Ch-UA-Mobile': '?0',
                'Sec-Ch-UA-Platform': '"Windows"',
            });
            await page.setViewport({ width: 1366, height: 768 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36');

            let varProductPrice = 'No Result';
            let varProductStock = 'No Result';
            let varProductImage = 'No Result';
            let varProductReview = 'No Result';
            let varProductRating = 'No Result';
            let scrapeStatus = 'pending';
            let modifiedDate;

            try {
                // Navigate with domcontentloaded and 60s timeout
                logger.info(`Loading ${productId} (${processed}/${total})`);
                await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

                // Check for JSON-LD
                const jsonLdExists = await page.$('#jsonLD');
                if (!jsonLdExists) {
                    logger.warn(`JSON-LD not found for ${productId}`);
                } else {
                    // Extract data
                    const result = await page.evaluate(() => {
                        const jsonLd = document.querySelector('#jsonLD');
                        if (!jsonLd) return null;
                        try {
                            const parsed = JSON.parse(jsonLd.textContent);
                            if (!Array.isArray(parsed) || parsed.length === 0) return null;
                            const data = parsed[0];
                            return {
                                price: data.offers?.price ? `₹${data.offers.price}` : '',
                                availability: data.offers?.availability || '',
                                image: Array.isArray(data.image) ? data.image[0] : data.image || '',
                                review: data.aggregateRating?.ratingCount || 0,
                                rating: data.aggregateRating?.ratingValue || 0
                            };
                        } catch {
                            return null;
                        }
                    });

                    if (result) {
                        const availability = (result.availability || '').toLowerCase().trim();
                        varProductImage = result.image || 'No Result';
                        varProductReview = result.review != null ? Number(result.review) : 'No Result';
                        varProductRating = result.rating != null ? Number(result.rating) : 'No Result';

                        if (availability.includes('instock')) {
                            const cleanedPrice = (result.price || '').replace(/[^0-9.]/g, '');
                            varProductPrice = parseFloat(cleanedPrice) || 0;
                            varProductStock = 'In stock';
                        } else if (availability.includes('outofstock') || availability.includes('currently unavailable')) {
                            varProductStock = 'Out Of Stock';
                        }
                        scrapeStatus = 'completed';
                    }
                }

                modifiedDate = getCurrentIndTimeInfo('India_Railway_Date_Time');

                // Update price change
                updatePriceChangeData(
                    scrapeStatus,
                    product.product_price,
                    varProductPrice,
                    productId,
                    productCode,
                    cronName,
                    cmpid,
                    companyId
                );

                // Update DB
                await executeMongoUpdate(
                    { collection: 'ept_product_details_new_flipkart', cmpid },
                    { [`${companyId}_product_id`]: productId, [`${companyId}_product_code`]: productCode },
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

                const productResult = {
                    product_ean_id: productId,
                    product_code: productCode,
                    product_price: varProductPrice,
                    product_stock: varProductStock,
                    modified_date: modifiedDate,
                    scrape_status: scrapeStatus
                };
                scrapedData.push(productResult);

                // ── Send product result event ──────────────────────
                sendEvent('product', {
                    productNumber: processed,
                    totalProducts: total,
                    processedProducts: processed,
                    progress: Math.round((processed / total) * 100),
                    productId,
                    productCode,
                    status: scrapeStatus === 'completed' ? 'success' : 'pending',
                    data: productResult
                });

                // Update cron progress
                if (!isSingleProduct) {
                    await updateEndTimeInDb(processed, 'running', cmpid, companyId, null, cronName, cronStartTime, total);
                }

            } catch (err) {
                logger.error(`Error scraping ${productId}: ${err.message}`);
                // Mark as pending in DB
                try {
                    await executeMongoUpdate(
                        { collection: 'ept_product_details_new_flipkart', cmpid },
                        { [`${companyId}_product_id`]: productId, [`${companyId}_product_code`]: productCode },
                        {
                            $set: {
                                product_scrape_status: 'pending',
                                modified_date: getCurrentIndTimeInfo('India_Railway_Date_Time')
                            }
                        }
                    );
                } catch (dbErr) {
                    logger.error(`DB update error for ${productId}: ${dbErr.message}`);
                }

                // Send product error event (still a 'product' event with error flag)
                sendEvent('product', {
                    productNumber: processed,
                    totalProducts: total,
                    processedProducts: processed,
                    progress: Math.round((processed / total) * 100),
                    productId,
                    productCode,
                    status: 'error',
                    error: err.message || 'Scraping failed',
                    data: null
                });
            } finally {
                await page.close().catch(() => {});
            }

            // Small delay between products
            await delay(100);
        }

        // ── Final summary ────────────────────────────────────────
        const endTime = new Date(`${getCurrentIndTimeInfo('India_Railway_Date_Only')}T${getCurrentIndTimeInfo('India_Railway_Time')}`);
        const totalMins = +((endTime - startTime) / 60000).toFixed(2);

        if (!isSingleProduct) {
            await updateEndTimeInDb(processed, 'ending', cmpid, companyId, totalMins, cronName, cronStartTime, total);
        }

        sendEvent('complete', {
            status: true,
            message: 'Scraping completed',
            totalProducts: total,
            totalProcessed: processed,
            progress: 100,
            totalMinutes: totalMins,
            data: scrapedData
        });

        res.end();

    } catch (err) {
        logger.error(`Fatal error: ${err.message}`);
        if (!res.writableEnded) {
            sendEvent('error', { status: false, message: err.message || 'Scraping failed' });
            res.end();
        }
    } finally {
        if (browser) {
            logger.info('Closing browser...');
            await browser.close().catch(() => {});
        }
    }
}

module.exports = { flipkartScraper };