const express = require('express');
const cors = require('cors');

require('dotenv').config({
    quiet: true
});


const {
    scrapeProduct
} = require('./server');

const {
    amazonScraper
} = require('./amazon');

const {
    flipkartScraper
} = require('./flipkart');

const {
    nikshanScraper
} = require('./nikshan');

const {
    vijaysalesScraper
} = require('./vijaysales');

const {
    reliancedigitalScraper
} = require('./reliancedigital');

const {
    poorvikaScraper
} = require('./poorvika');

const {
    mygScraper
} = require('./myg');

const {
    darlingretail_Scraper
} = require('./darling_retail');

const {
    vasanth_coScraper
} = require('./vasanth_co');

const {
    sonovisionScraper
} = require('./sonovision');

const {
    bajaj_electronicsScraper
} = require('./bajaj_electronics');

const {
    sonyScraper
} = require('./sony');

const {
    lgScraper
} = require('./lg');

const {
    jiomartScraper
} = require('./jiomart');

const {
    sathyaScraper
} = require('./sathya');

const {
    cromaScraper
} = require('./croma');

const {
    supremeMobilesScraper
} = require('./supreme_mobiles');

const {
    pittappillilScraper
} = require('./pittappillil');

const {
    executeMongoFind
} = require('./mongo');


const app = express();


/*
============================================================
CORS
============================================================
*/

app.use(
    cors({

        origin: [
            'https://epricetrack.com',
            'https://www.epricetrack.com',
            'http://localhost:8080'
        ],

        methods: [
            'GET',
            'POST',
            'PUT',
            'DELETE',
            'OPTIONS'
        ],

        allowedHeaders: [
            'Content-Type',
            'Authorization'
        ]
    })
);


app.use(express.json());


/*
============================================================
SSE KEEP ALIVE
============================================================
*/

app.use('/flipkart', (req, res, next) => {

    res.setHeader(
        'Cache-Control',
        'no-cache, no-transform'
    );

    res.setHeader(
        'X-Accel-Buffering',
        'no'
    );

    next();
});


/*
============================================================
ROUTES
============================================================
*/

app.get(
    '/scrape',
    scrapeProduct
);

app.get(
    '/amazon',
    amazonScraper
);

app.get(
    '/flipkart',
    flipkartScraper
);

app.get(
    '/nikshan',
    nikshanScraper
);

app.get(
    '/vijaysales',
    vijaysalesScraper
);

app.get(
    '/reliancedigital',
    reliancedigitalScraper
);

app.get(
    '/poorvika',
    poorvikaScraper
);

app.get(
    '/myg',
    mygScraper
);

app.get(
    '/darling_retail',
    darlingretail_Scraper
);

app.get(
    '/vasanth_co',
    vasanth_coScraper
);

app.get(
    '/sonovision',
    sonovisionScraper
);

app.get(
    '/bajaj_electronics',
    bajaj_electronicsScraper
);

app.get(
    '/sony',
    sonyScraper
);

app.get(
    '/lg',
    lgScraper
);

app.get(
    '/jiomart',
    jiomartScraper
);

app.get(
    '/sathya',
    sathyaScraper
);

app.get(
    '/croma',
    cromaScraper
);

app.get(
    '/supreme_mobiles',
    supremeMobilesScraper
);

app.get(
    '/pittappillil',
    pittappillilScraper
);


/*
============================================================
SERVER
============================================================
*/

const PORT =
    process.env.PORT || 3000;


app.listen(
    PORT,
    () => {

        console.log(
            `Server running on port ${PORT}`
        );
    }
);