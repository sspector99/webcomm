const { app, BrowserWindow, session } = require('electron')
const fs = require('fs')
const path = require('path')

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

        // Define where to save the file (this saves it right inside your project folder)
        const filePath = path.join(__dirname, 'roster_output.json');
        
        // Convert the array into a nicely formatted string and write it to disk
        fs.writeFileSync(filePath, JSON.stringify(fullMonthRoster, null, 2), 'utf-8');
        console.log(`💾 SUCCESS: Saved full roster data to file at: ${filePath}`);

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
    console.error("❌ Could not isolate the calendar grid from the text.");
    return fullRosterJson;
  }
  
  const gridText = match[1];

  // 2. Extract every day number and its associated duty token block
  const dayPattern = /(\d{1,2})\s+([A-Z0-9a-z\-_,\s\.]+?)(?=\s+\d{1,2}\s+|\s*\$)/g;
  
  let itemMatch;
  let lastDayNumber = 0;
  const calendarMap = {};

  while ((itemMatch = dayPattern.exec(gridText)) !== null) {
    const dayNum = parseInt(itemMatch[1], 10);
    let rawStatus = itemMatch[2].trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' '); 

    // Handle month spillage boundaries
    if (dayNum < lastDayNumber && lastDayNumber >= 28) break;
    if (lastDayNumber === 0 && dayNum > 7) continue;

    lastDayNumber = dayNum;
    calendarMap[dayNum] = rawStatus;
  }

  // 3. Extract the detailed duty configurations from the bottom of the text dump
  const dutyDetailsMap = {};
  const lines = text.split('\n');
  
  lines.forEach(line => {
    if (line.trim().startsWith('Duty:')) {
      let cleanLine = line.replace(/•/g, ' ').replace(/\s{2,}/g, ' ').replace(/ /g, ' ').trim();

      const dutyMatch = cleanLine.match(/Duty:\s*(.*?)\s*Valid from:/);
      const validFromMatch = cleanLine.match(/Valid from:\s*([\d\/]+)/);
      const timeMatch = cleanLine.match(/Time:\s*([\d:]+\s*-\s*[\d:]+)/);
      const durationMatch = cleanLine.match(/Duty duration:\s*([^\s]+)/);
      const wageMatch = cleanLine.match(/Wage hours:\s*([^\s]+)/);
      const dayTypeMatch = cleanLine.match(/Day type:\s*(.*?)\s*Duty type:/);
      const dutyTypeMatch = cleanLine.match(/Duty type:\s*(.*?)\s*Start location:/);
      const locationMatch = cleanLine.match(/Start location:\s*(.*?)\s*Name:/);
      const nameMatch = cleanLine.match(/Name:\s*(.*)\$/);

      if (dutyMatch) {
        const dutyKey = dutyMatch[1].trim();
        dutyDetailsMap[dutyKey] = {
          validFrom: validFromMatch ? validFromMatch[1] : null,
          time: timeMatch ? timeMatch[1] : null,
          dutyDuration: durationMatch ? `${durationMatch[1]} Hrs` : null,
          wageHours: wageMatch ? `${wageMatch[1]} Hrs` : null,
          dayType: dayTypeMatch ? dayTypeMatch[1].trim() : null,
          dutyType: dutyTypeMatch ? dutyTypeMatch[1].trim() : null,
          startLocation: locationMatch ? locationMatch[1].trim() : null,
          name: nameMatch ? nameMatch[1].trim() : null
        };
      }
    }
  });

  // 4. Assemble the final unified 30-day array
  for (let day = 1; day <= 30; day++) {
    const paddedDay = String(day).padStart(2, '0');
    const dateString = `${paddedDay}/09/2026`;
    
    const status = calendarMap[day] || "OFF";
    const isOffDay = status === "OFF" || status === "RDO";

    // Split multi-duties cleanly into an array list, filtering out the trailing "..."
    let dutiesArray = [];
    if (!isOffDay) {
      dutiesArray = status.replace(/\.\.\./g, '')
                          .split(',')
                          .map(d => d.trim())
                          .filter(d => d.length > 0);
    }

    // Smart Match: Try finding exact matching text block first
    let details = dutyDetailsMap[status] || null;
    
    // Fallback 1: Match by stripping the trailing "..." text truncation noise
    if (!details && !isOffDay) {
      const cleanStatus = status.replace(/\.\.\./g, '').trim();
      details = dutyDetailsMap[cleanStatus] || null;
    }

    // Fallback 2: If it still misses (like on day 29), look up using just the primary first duty item number
    if (!details && dutiesArray.length > 0) {
      const primaryDuty = dutiesArray[0];
      
      // Scan our map keys to see if any saved duty sequence starts with this number
      const matchingKey = Object.keys(dutyDetailsMap).find(key => key.startsWith(primaryDuty));
      if (matchingKey) {
        details = dutyDetailsMap[matchingKey];
      }
    }

    fullRosterJson.push({
      date: dateString,
      day: day,
      isOff: isOffDay,
      status: status,
      duties: dutiesArray,
      details: details
    });
  }
  
  return fullRosterJson;
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})