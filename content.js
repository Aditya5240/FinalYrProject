// console.log("Gmail AI Reply: content script loaded");
// learning-1 : ctrl + shift + I ,open console

// window.addEventListener("load", () => {
//     console.log("Gmail page fully load");
//     console.log("Page title is: ", document.title);
// });

// learning-2 : mutation observer is a built in browser API that watches a 
//              part of the DOM and fires a callback everytime something changes
//              inside it.   


// let count = 0;

// const observer = new MutationObserver(() => {
//     count++;
//     console.log("DOM changed, mutation #", count);
//     if(count >= 5) {
//         observer.disconnect();
//         console.log("Stopped observing after 5 mutations");
//     }
// });

// observer.observe(document.body, { childList: true, subtree: true });

// window.addEventListener("load", () => {
//     const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');
//     console.log("Found", composeBoxes.length, "compose boxes");

//     composeBoxes.forEach((box) => {
//         console.log(box);
//     });
// });

function scanForComposeBoxes() {
  const composeBoxes = document.querySelectorAll('div[aria-label="Message Body"][role="textbox"]');
  console.log("Found", composeBoxes.length, "compose boxes");
}

const observer = new MutationObserver(() => {
  scanForComposeBoxes();
});

observer.observe(document.body, { childList: true, subtree: true });

scanForComposeBoxes();