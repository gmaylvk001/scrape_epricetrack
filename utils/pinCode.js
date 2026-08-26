const { getMainDb } = require("../mongo");

/* GET PINCODE FOR CLIENT */

async function getStorePincode(companyId) {

    if (!companyId) {
        throw new Error('companyId is required to get store pincode');
    }

    const mainDb = await getMainDb();

    const filter = {
        cmpid: companyId
    };

    const existing = await mainDb
        .collection("plm_admin_cmp_merchant_accounts")
        .findOne(
            filter,
            {
                projection: {
                    _id: 0,
                    pincode: 1
                }
            }
        );

    return existing?.pincode || null;
}

module.exports = {
    getStorePincode
};