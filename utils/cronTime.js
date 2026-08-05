const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const { executeMongoUpdate, executeMongoFind, executeMongoInsert } = require('../mongo');


function getCurrentIndTimeInfo(param) {

    const now = dayjs().tz('Asia/Kolkata');

    switch (param) {
        case 'India_Railway_Date_Time':
            return now.format('YYYY-MM-DD HH:mm:ss');

        case 'India_Railway_Time':
            return now.format('HH:mm:ss');

        case 'India_Railway_Hour_Only':
            return now.format('HH');

        case 'India_Railway_Date_Only':
            return now.format('YYYY-MM-DD');

        case 'India_Railway_Date_Yesterday':
            return now.subtract(1, 'day').format('YYYY-MM-DD');

        default:
            return now.format('YYYY-MM-DD hh:mm:ssA');
    }
}

async function updateStartTimeInDb(cmpid, companyId, cronName, scrapingProductCount) {

    const startTime = getCurrentIndTimeInfo();

    const filter = {
        cron_competitor_name: cronName,
        cmpid: companyId
    };

    const existing = await executeMongoFind(
        {
            collection: 'ept_cron_time_management',
            cmpid
        },
        filter,
        { _id: 1 }
    );

    if (existing && existing.length > 0) {

        await executeMongoUpdate(
            {
                collection: 'ept_cron_time_management',
                cmpid
            },
            filter,
            {
                $set: {
                    start_time: startTime,
                    total_count: scrapingProductCount,
                    end_time: '',
                    update_count: '',
                    process_count: ''
                }
            }
        );
    } else {
       
        await executeMongoInsert(
            {
                collection: 'ept_cron_time_management',
                cmpid
            },
            {
                cron_competitor_name: cronName,
                cmpid: companyId,
                start_time: startTime,
                total_count: scrapingProductCount,
                end_time: '',
                update_count: '',
                process_count: '',
            }
        );
    }
}

async function updateEndTimeInDb(processCount, process, cmpid, companyId, totalMins, cronName, startTime, ScrapingProductCount) {

    const endTime = getCurrentIndTimeInfo();

    const updateData =
        process === 'ending'
            ? {
                  $set: {
                      end_time: endTime,
                      update_count: processCount,
                      total_mins: totalMins
                  }
              }
            : {
                  $set: {
                      process_count: processCount
                  }
              };

    await executeMongoUpdate(
        {
            collection: 'ept_cron_time_management',
            cmpid
        },
        {
            cron_competitor_name: cronName,
            cmpid: companyId
        },
        updateData
    );

    if(process === 'ending'){
        
        const today = new Date();
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(today.getDate() - 7);
        const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];
        const newLog = {
            date: getCurrentIndTimeInfo('India_Railway_Date_Only'),
            start_time: startTime,
            end_time: endTime,
            total_count: ScrapingProductCount,
            update_count: processCount,
            total_mins: totalMins
        };

        // Remove old logs
        await executeMongoUpdate(
            {
                collection: 'ept_cron_time_management',
                cmpid
            },
            {
                cron_competitor_name: cronName,
                cmpid: companyId
            },
            {
                $pull: {
                    logs: {
                        date: { $lt: cutoffDate }
                    }
                }
            }
        );

        // Add new log
        await executeMongoUpdate(
            {
                collection: 'ept_cron_time_management',
                cmpid
            },
            {
                cron_competitor_name: cronName,
                cmpid: companyId
            },
            {
                $push: {
                    logs: newLog
                }
            }
        );

    }



}

module.exports = {
    getCurrentIndTimeInfo,
    updateStartTimeInDb,
    updateEndTimeInDb
};