const { executeMongoFind, getMainDb } = require("../mongo");

async function getStorePincode(companyId) {

    const mainDb = await getMainDb();

    const filter = {
        cmpid: companyId
    };

    const existing = await executeMongoFind(
        {
            collection: "plm_admin_cmp_merchant_accounts",
            db: mainDb
        },
        filter,
        { _id: 0, pincode: 1 }
    );

    return existing?.[0]?.pincode || null;
}

module.exports = {
    getStorePincode
};