async function PincodeApplied(
    browser,
    pincode,
    cronName,
    homepage,
    pincodeSelectors,
    sendEvent
) {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    let mainPage = null;
    const formattedCronName =
    cronName.charAt(0).toUpperCase() + cronName.slice(1);

    try {
        if (!pincode) {
            sendEvent('step', {
                step: 'pincode',
                status: 'skipped',
                message: 'No pincode provided'
            });

            return {
                success: false,
                message: 'No pincode provided'
            };
        }

        // Create page
        mainPage = await browser.newPage();

        await mainPage.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        );

        await mainPage.setExtraHTTPHeaders({
            'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
            'Sec-Ch-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
            'Sec-Ch-UA-Mobile': '?0',
            'Sec-Ch-UA-Platform': '"Windows"'
        });

        await mainPage.setViewport({
            width: 1366,
            height: 768
        });

        sendEvent('step', {
            step: 'pincode',
            status: 'running',
            message: `Opening ${formattedCronName} to set pincode: ${pincode}`
        });

        // Open homepage
        await mainPage.goto(homepage, {
            waitUntil: 'networkidle2',
            timeout: 50000
        });

        await delay(3000);

        const containerSelector = pincodeSelectors.container;
        const inputSelector = pincodeSelectors.inputfiled;
        const applySelector = pincodeSelectors.applyfield;

        /*
        ========================================================
        CHECK PINCODE BUTTON
        ========================================================
        */

        const pincodeButton = await mainPage.$(containerSelector);

        if (!pincodeButton) {
            console.log(`${formattedCronName} pincode button not found`);

            sendEvent('step', {
                step: 'pincode',
                status: 'skipped',
                message: `${formattedCronName} pincode button not found, continuing...`
            });

            return {
                success: false,
                skipped: true,
                message: 'Pincode button not found'
            };
        }

        /*
        ========================================================
        CLICK PINCODE BUTTON
        ========================================================
        */

        await mainPage.waitForSelector(containerSelector, {
            visible: true,
            timeout: 15000
        });

        await mainPage.click(containerSelector);

        await delay(2000);

        /*
        ========================================================
        WAIT FOR PINCODE INPUT
        ========================================================
        */

        await mainPage.waitForSelector(inputSelector, {
            visible: true,
            timeout: 15000
        });

        /*
        ========================================================
        CLEAR PINCODE INPUT
        ========================================================
        */

        await mainPage.evaluate((selector) => {
            const input = document.querySelector(selector);

            if (input) {
                input.value = '';
                input.focus();

                input.dispatchEvent(
                    new Event('input', {
                        bubbles: true
                    })
                );

                input.dispatchEvent(
                    new Event('change', {
                        bubbles: true
                    })
                );
            }
        }, inputSelector);

        await delay(500);

        /*
        ========================================================
        TYPE PINCODE
        ========================================================
        */

        await mainPage.type(
            inputSelector,
            String(pincode),
            {
                delay: 100
            }
        );

        await delay(1000);

        /*
        ========================================================
        CLICK APPLY
        ========================================================
        */

        const applyClicked = await mainPage.evaluate((selector) => {

            const elements = document.querySelectorAll(selector);

            for (const element of elements) {

                const text = element.textContent
                    ?.trim()
                    .toLowerCase();

                if (text === 'apply' || text === 'Submit') {
                    element.click();
                    return true;
                }

                const button = element.closest('button');

                if (button) {
                    const buttonText = button.textContent
                        ?.trim()
                        .toLowerCase();

                    if (buttonText === 'apply' || buttonText === 'Submit') {
                        button.click();
                        return true;
                    }
                }
            }

            return false;

        }, applySelector);

        if (!applyClicked) {

            console.log(` ${formattedCronName} Apply button not clicked`);

            sendEvent('step', {
                step: 'pincode',
                status: 'warning',
                message: `Unable to click Apply button for pincode ${pincode}`
            });

        }

        /*
        ========================================================
        WAIT FOR APPLY PINCODE
        ========================================================
        */

        await delay(3000);

        /*
        ========================================================
        VERIFY PINCODE
        ========================================================
        */

        const pincodeSet = await mainPage.evaluate(
            ({ expectedPincode, containerSelector, inputSelector }) => {

                // Check location container
                const container = document.querySelector(
                    containerSelector
                );

                if (
                    container &&
                    container.textContent.includes(expectedPincode)
                ) {
                    return true;
                }

                // Check input value
                const input = document.querySelector(inputSelector);

                if (
                    input &&
                    input.value === expectedPincode
                ) {
                    return true;
                }

                // Check entire page text
                if (
                    document.body &&
                    document.body.innerText.includes(expectedPincode)
                ) {
                    return true;
                }

                return false;

            },
            {
                expectedPincode: String(pincode),
                containerSelector,
                inputSelector
            }
        );

        /*
        ========================================================
        RESULT
        ========================================================
        */

        if (pincodeSet) {

            sendEvent('step', {
                step: 'pincode',
                status: 'completed',
                message: `${formattedCronName} pincode set successfully: ${pincode}`
            });

            return {
                success: true,
                pincode
            };

        }

        sendEvent('step', {
            step: 'pincode',
            status: 'warning',
            message: `${formattedCronName} pincode may not have been applied: ${pincode}`
        });

        return {
            success: false,
            pincode,
            message: 'Pincode verification failed'
        };

    } catch (err) {

        console.log(
            `Unable to set ${formattedCronName} pincode:`,
            err.message
        );

        sendEvent('step', {
            step: 'pincode',
            status: 'failed',
            message: `Unable to set ${formattedCronName} pincode: ${err.message}`
        });

        return {
            success: false,
            pincode,
            error: err.message
        };

    } finally {

        // Close only the temporary pincode page
        if (mainPage) {
            try {
                await mainPage.close();
            } catch (e) {
                console.log(
                    'Unable to close pincode page:',
                    e.message
                );
            }
        }
    }
}

module.exports = {
    PincodeApplied
};