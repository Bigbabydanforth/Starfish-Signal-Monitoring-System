const fs = require('fs');
const path = require('path');

const ids = [
  'd545d2f6-9036-48bb-b1bf-ee314f34a4dd',
  '78af930d-448e-4aa6-8827-a84ffbf56f2b',
  'ec77051c-2485-4732-877e-f48a14072ccc'
];

const brainDir = 'C:\\Users\\GIDEON\\.gemini\\antigravity-ide\\brain';

for (const id of ids) {
  const folderPath = path.join(brainDir, id);
  console.log(`\n==================================================`);
  console.log(`CONVERSATION ID: ${id}`);
  console.log(`==================================================`);
  
  // Read implementation plan if exists
  const ipPath = path.join(folderPath, 'implementation_plan.md');
  if (fs.existsSync(ipPath)) {
    console.log(`\n[Implementation Plan Title]:`);
    const plan = fs.readFileSync(ipPath, 'utf8');
    console.log(plan.split('\n').slice(0, 5).join('\n'));
  }
  
  // Read system report if exists
  const srPath = path.join(folderPath, 'system_report.md');
  if (fs.existsSync(srPath)) {
    console.log(`\n[System Report Preview]:`);
    const report = fs.readFileSync(srPath, 'utf8');
    console.log(report.split('\n').slice(0, 10).join('\n'));
  }

  // Read walkthrough if exists
  const wtPath = path.join(folderPath, 'walkthrough.md');
  if (fs.existsSync(wtPath)) {
    console.log(`\n[Walkthrough Preview]:`);
    const wt = fs.readFileSync(wtPath, 'utf8');
    console.log(wt.split('\n').slice(0, 10).join('\n'));
  }

  // Read overview.txt
  const ovPath = path.join(folderPath, '.system_generated', 'logs', 'overview.txt');
  if (fs.existsSync(ovPath)) {
    console.log(`\n[Overview.txt log - First 1500 chars]:`);
    const ov = fs.readFileSync(ovPath, 'utf8');
    // Let's clean up line objects to make it readable if it's JSON lines
    try {
      const lines = ov.trim().split('\n');
      let count = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.type === 'USER_INPUT') {
          console.log(`USER: ${entry.content.replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim()}`);
        } else if (entry.type === 'PLANNER_RESPONSE') {
          console.log(`ASSISTANT: ${entry.content}`);
        }
        count++;
        if (count > 15) {
          console.log('... truncated ...');
          break;
        }
      }
    } catch (e) {
      console.log(ov.substring(0, 1500));
    }
  }
}
