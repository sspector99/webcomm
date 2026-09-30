const { app, BrowserWindow, session } = require('electron')

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
    }
  })

  mainWindow.webContents.openDevTools();

  const filter = { urls: ['*://*.nctx.co.uk/*'] };

  // --- NEW CODE: BYPASS CONTENT SECURITY POLICY (CSP) ERRORS ---
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    
    // Look for security headers that block inline scripts and delete them locally
    Object.keys(responseHeaders).forEach((headerName) => {
      if (headerName.toLowerCase() === 'content-security-policy' || 
          headerName.toLowerCase() === 'content-security-policy-report-only') {
        delete responseHeaders[headerName];
      }
    });

    callback({ cancel: false, responseHeaders });
  });
  // -------------------------------------------------------------


  mainWindow.webContents.on('did-finish-load', async () => {
    const currentUrl = mainWindow.webContents.getURL();
    console.log("Current Window URL:", currentUrl);

    // AUTOMATION A: If you just logged in and hit the main dashboard/menu, bypass it!
    // (If your main menu URL after login is different, replace '/dashboard.aspx' below)
    if (currentUrl.includes('/default.aspx') || currentUrl.endsWith('/WebComm/')) {
      // Inject a script to check if we are on the login screen or the main menu
      const checkMenuScript = `
        (function() {
          // Look for common login elements (like a password field)
          const hasPasswordInput = document.querySelector('input[type="password"]') !== null;
          
          // Look for clues that the main menu/roster links are rendered on screen
          const hasRosterLink = Array.from(document.querySelectorAll('a, button'))
                                     .some(el => el.textContent.includes('Roster'));

          if (!hasPasswordInput && hasRosterLink) {
            return "LOGGED_IN_MAIN_MENU";
          } else if (hasPasswordInput) {
            return "LOGIN_SCREEN";
          }
          return "UNKNOWN";
        })();
      `;

      try {
        const pageState = await mainWindow.webContents.executeJavaScript(checkMenuScript);
        console.log("🔍 Page State Analysis:", pageState);

        if (pageState === "LOGGED_IN_MAIN_MENU") {
          console.log("🎯 Main menu detected on default.aspx. Bypassing straight to roster calendar...");
          mainWindow.loadURL('https://webcomm.nctx.co.uk/WebComm/roster.aspx');
        } else {
          console.log("🔒 Sitting on login screen, waiting for user credentials...");
        }
      } catch (error) {
        console.error("Failed to evaluate page elements:", error);
      }
    }


    // AUTOMATION B: If we are actively on the roster calendar page, extract the text!
    if (currentUrl.includes('roster.aspx')) {
      console.log("📅 Roster page fully loaded! Attempting to extract calendar data...");

      // This script grabs all the raw visible text inside the web page body
      const extractionScript = `document.body.innerText;`;

      try {
        const pageText = await mainWindow.webContents.executeJavaScript(extractionScript);
        
        // Run our bulletproof regex calendar parser!
        const fullMonthRoster = parseFullMonthRoster(pageText);
        
        console.log("==================== CONVERTED FULL MONTH JSON ====================");
        console.log(JSON.stringify(fullMonthRoster, null, 2));
        console.log("===================================================================");
      } catch (error) {
        console.error("Failed to extract calendar text:", error);
      }
    }
  })

  // Load the WebComm login page
  mainWindow.loadURL('https://webcomm.nctx.co.uk/WebComm/default.aspx');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

}

// --- BULLETPROOF REGEX CALENDAR PARSER ---
function parseFullMonthRoster(text) {
  const fullRosterJson = [];
  
  // 1. Isolate the grid text between the day name headers
  const gridRegex = /Sunday\s+Monday\s+Tuesday\s+Wednesday\s+Thursday\s+Friday\s+Saturday([\s\S]*?)Sunday\s+Monday\s+Tuesday\s+Wednesday\s+Thursday\s+Friday\s+Saturday/;
  const match = text.match(gridRegex);
  
  if (!match) {
    console.log("❌ Could not isolate the calendar grid context from text.");
    return fullRosterJson;
  }
  
  const gridText = match[1];

  // 2. Global Regex match: Plucks a number string, followed by whitespace/newlines, followed by a duty designation/OFF/RDO string
  // It handles list strings like "2557, 2523-1" or "S0600T,3183,3005,617" perfectly
  const dayPattern = /(\d{1,2})\s+([A-Z0-9a-z\-_,\s]+?)(?=\s+\d{1,2}\s+|\s*\$)/g;
  
  let itemMatch;
  let lastDayNumber = 0;

  while ((itemMatch = dayPattern.exec(gridText)) !== null) {
    const dayNum = parseInt(itemMatch[1], 10);
    let rawStatus = itemMatch[2].trim().replace(/[\r\n]+/g, ' '); // Clean out vertical formatting noise

    // Filter out trailing days from next month or leading spillage from previous month
    if (dayNum < lastDayNumber && lastDayNumber >= 28) break;
    if (lastDayNumber === 0 && dayNum > 7) continue;

    lastDayNumber = dayNum;

    const paddedDay = String(dayNum).padStart(2, '0');
    const dateString = `${paddedDay}/09/2026`;
    const isOffDay = rawStatus === "OFF" || rawStatus === "RDO";

    // Split duties cleanly by comma if it's a working day
    let dutiesArray = [];
    if (!isOffDay) {
      dutiesArray = rawStatus.split(',')
                             .map(d => d.trim())
                             .filter(d => d.length > 0);
    }

    fullRosterJson.push({
      date: dateString,
      day: dayNum,
      duties: dutiesArray,
      isOff: isOffDay,
      rawStatus: rawStatus
    });
  }
  
  return fullRosterJson;
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})