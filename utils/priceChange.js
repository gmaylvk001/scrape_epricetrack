const { executeMongoUpdate } = require("../mongo");

async function updatePriceChangeData(scrapeStatus, oldPrice, newPrice, ean, code, cronName, cmpid, companyId) {

    const priceChange = { 
        status: "pending",
        decreasedValue: 0,
        increasedValue: 0,
        oldPriceValue: 0,
        newPriceValue: 0
    };

    if(scrapeStatus === 'completed'){

        const normalizePrice = (price) => {
            if (
                price === "No Result" ||
                price === null ||
                price === undefined
            ) {
                return 0;
            }

            const value = parseFloat(String(price).replace(/,/g, ""));
            return isNaN(value) ? 0 : value;
        };

        const oldVal = normalizePrice(oldPrice);
        const newVal = normalizePrice(newPrice);

        priceChange.oldPriceValue = oldVal;
        priceChange.newPriceValue = newVal;

        if (newVal < oldVal) {
            priceChange.status = "decreased";
            priceChange.decreasedValue = oldVal - newVal;
        } else if (newVal > oldVal) {
            priceChange.status = "increased";
            priceChange.increasedValue = newVal - oldVal;

        } else if (newVal === oldVal) {
            priceChange.status = "not_changed";
        }
        
    }

    await executeMongoUpdate(
        {
            collection: `ept_product_details_new_${cronName}`,
            cmpid
        },
        {
            [`${companyId}_product_id`]: ean,
            [`${companyId}_product_code`]: code
        },
        {
            $set: {
                pricechange: priceChange
            }
        }
    );

}


module.exports = {
    updatePriceChangeData
};