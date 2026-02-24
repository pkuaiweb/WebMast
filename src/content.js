console.log("[Content Script] Script injected into page:", window.location.href);

// Only the content script is able to access the DOM
chrome.runtime.onConnect.addListener(function (port) {
  port.onMessage.addListener(function (msg) {
    port.postMessage({ contents: document.body.innerText });
  });
});

// Pre-process page when it loads - send content to background for summarization
function notifyBackgroundForPreprocessing() {
  const pageContent = document.body.innerText;
  const pageUrl = window.location.href;
  const pageTitle = document.title;

  console.log("[Content Script] notifyBackgroundForPreprocessing called");
  console.log("[Content Script] Page loaded:", pageTitle, "Content length:", pageContent?.length);

  // Only process if content is substantial enough
  if (pageContent && pageContent.length > 100) {
    // Use a retry mechanism in case background isn't ready
    let retries = 0;
    const maxRetries = 3;
    
    function sendMessage() {
      console.log("[Content Script] Attempting to send page for preprocessing (attempt " + (retries + 1) + ")");
      
      chrome.runtime.sendMessage({
        type: "PAGE_LOADED",
        data: {
          url: pageUrl,
          title: pageTitle,
          content: pageContent
        }
      }, function(response) {
        if (chrome.runtime.lastError) {
          console.log("[Content Script] Error sending message:", chrome.runtime.lastError.message);
          retries++;
          if (retries < maxRetries) {
            // Retry after a delay
            setTimeout(sendMessage, 1000 * retries);
          }
        } else {
          console.log("[Content Script] Page sent for preprocessing, response:", response);
        }
      });
    }
    
    sendMessage();
  } else {
    console.log("[Content Script] Page content too short, skipping preprocessing");
  }
}

// Trigger preprocessing when page is fully loaded
// Also add a small delay to ensure DOM is ready
function initPreprocessing() {
  // Small delay to ensure everything is loaded
  setTimeout(notifyBackgroundForPreprocessing, 500);
}

if (document.readyState === 'complete') {
  initPreprocessing();
} else {
  window.addEventListener('load', initPreprocessing);
}

// Also listen for DOMContentLoaded as a fallback
document.addEventListener('DOMContentLoaded', function() {
  // Delay to ensure body content is available
  setTimeout(function() {
    if (document.body && document.body.innerText && document.body.innerText.length > 100) {
      console.log("[Content Script] DOMContentLoaded triggered preprocessing");
      notifyBackgroundForPreprocessing();
    }
  }, 1000);
});
