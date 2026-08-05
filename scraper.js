const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({
        headless: true
    });

    const page = await browser.newPage();

    await page.goto('https://example.com', {
        waitUntil: 'networkidle2'
    });

    const data = await page.evaluate(() => {
        return {
            title: document.title,
            heading: document.querySelector('h1')?.innerText
        };
    });

    console.log(data);

    fs.writeFileSync(
        './output/data.json',
        JSON.stringify(data, null, 2)
    );

    await page.screenshot({
        path: './output/screenshot.png',
        fullPage: true
    });

    await browser.close();
})();