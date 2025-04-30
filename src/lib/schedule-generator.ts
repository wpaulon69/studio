
import type {
  Employee,
  Absence,
  Holiday,
  Schedule,
  ScheduleDay,
  ShiftType,
  ValidationResult,
  EmployeeTotals,
} from '@/types';
import { differenceInDays, format, parseISO, addDays, getDay, isWeekend, startOfMonth, endOfMonth, getDate, subDays, isValid } from 'date-fns';

// --- Constants and Configuration ---
const MAX_CONSECUTIVE_WORK_DAYS = 6;
const REQUIRED_DD_WEEKENDS = 1; // Minimum D/D weekends per eligible employee
const MIN_COVERAGE_TPT = 2;
const MIN_COVERAGE_M = 1;
const MIN_COVERAGE_T = 1;
// Define required D counts per employee NAME if applicable (Example)
const REQUIRED_D_COUNT_BY_NAME: { [name: string]: number } = {
  // Example: If Rios needs exactly 9 'D' shifts:
    'Rios': 9,
    'Molina': 9,
    'Montu': 9,
    'Cardozo': 9,
    'Forni': 9,
};
// Target staffing levels (flexible)
const TARGET_M_WORKDAY = 3;
const TARGET_M_WEEKEND_HOLIDAY = 2;
const TARGET_T = 1;


// --- Helper Functions ---

function getDatesForMonth(year: number, month: number): Date[] {
  const startDate = startOfMonth(new Date(year, month - 1));
  const endDate = endOfMonth(new Date(year, month - 1));
  const dates: Date[] = [];
  let currentDate = startDate;
  while (currentDate <= endDate) {
    dates.push(currentDate);
    currentDate = addDays(currentDate, 1);
  }
  return dates;
}

function initializeSchedule(year: number, month: number, employees: Employee[], holidays: Holiday[]): Schedule {
  const dates = getDatesForMonth(year, month);
  const scheduleDays: ScheduleDay[] = dates.map(date => {
    const dateStr = format(date, 'yyyy-MM-dd');
    return {
      date: dateStr,
      isWeekend: isWeekend(date),
      isHoliday: holidays.some(h => h.date === dateStr),
      shifts: employees.reduce((acc, emp) => {
        acc[emp.id] = null; // Initialize all shifts to null
        return acc;
      }, {} as { [employeeId: number]: ShiftType | null }),
      totals: { M: 0, T: 0, D: 0, C: 0, F: 0, LM: 0, LAO: 0, TPT: 0 },
    };
  });

  const employeeTotals: { [employeeId: number]: EmployeeTotals } = employees.reduce((acc, emp) => {
    acc[emp.id] = {
      workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, C: 0, D: 0, LM: 0, LAO: 0
    };
    return acc;
  }, {} as { [employeeId: number]: EmployeeTotals });

  return { year, month, days: scheduleDays, employeeTotals };
}

function applyAbsences(schedule: Schedule, absences: Absence[], employees: Employee[]) {
  const employeeMap = new Map(employees.map(e => [e.id, e]));
  absences.forEach(absence => {
    const employee = employeeMap.get(absence.employeeId);
    if (!employee || !absence.startDate || !absence.endDate) return; // Skip if employee not found or dates invalid

    try {
        const startDate = parseISO(absence.startDate);
        const endDate = parseISO(absence.endDate);
        if (!isValid(startDate) || !isValid(endDate)) {
             console.warn(`Invalid date format in absence for employee ${employee.name}: ${absence.startDate} - ${absence.endDate}`);
             return;
        }


        schedule.days.forEach(day => {
          const currentDate = parseISO(day.date);
          if (currentDate >= startDate && currentDate <= endDate) {
            // Do not overwrite if already set (e.g., another absence overlapping?) - Overwrite is usually fine if this is Prio 1
            // if (day.shifts[absence.employeeId] === null) {
                 day.shifts[absence.employeeId] = absence.type;
            // }
          }
        });
    } catch (e) {
         console.error(`Error processing absence for employee ${employee.name}:`, e);
    }
  });
}

function applyFixedAssignments(schedule: Schedule, employees: Employee[]) {
    employees.forEach(employee => {
        // Preferences might be undefined if not set in UI, default to empty object
        const prefs = employee.preferences || {};

        // Apply Fixed Assignments (M/T/D/C/F etc on specific dates)
        if (prefs.fixedAssignments) {
            prefs.fixedAssignments.forEach(assignment => {
                 if (!assignment.date || !assignment.shift) return; // Skip incomplete fixed assignments
                 try {
                    if (!isValid(parseISO(assignment.date))) return; // Skip invalid date format
                    const dayIndex = schedule.days.findIndex(d => d.date === assignment.date);
                    // Assign if slot is empty OR if the existing assignment is NOT LAO/LM (fixed assignments override generated D/C/F)
                    if (dayIndex !== -1 && (schedule.days[dayIndex].shifts[employee.id] === null || !['LAO', 'LM'].includes(schedule.days[dayIndex].shifts[employee.id]!))) {
                       schedule.days[dayIndex].shifts[employee.id] = assignment.shift;
                    }
                 } catch (e) {
                    console.warn(`Skipping invalid fixed assignment date for ${employee.name}: ${assignment.date}`)
                 }
            });
        }

        // Apply Fixed Days Off (Specific dates where employee MUST have 'D')
         if (prefs.fixedDaysOff) {
            prefs.fixedDaysOff.forEach(dateOff => {
                 if (!dateOff) return; // Skip empty fixed days off
                 try {
                    if (!isValid(parseISO(dateOff))) return; // Skip invalid date format
                     const dayIndex = schedule.days.findIndex(d => d.date === dateOff);
                     // Assign D if slot is empty OR if the existing assignment is NOT LAO/LM
                     if (dayIndex !== -1 && (schedule.days[dayIndex].shifts[employee.id] === null || !['LAO', 'LM'].includes(schedule.days[dayIndex].shifts[employee.id]!))) {
                         // Check if it's a holiday - Prio 3 forbids D on Holiday
                        if (!schedule.days[dayIndex].isHoliday) {
                            schedule.days[dayIndex].shifts[employee.id] = 'D';
                        } else {
                            console.warn(`Cannot assign fixed 'D' to ${employee.name} on holiday ${dateOff}. Leaving as is.`);
                            // Optionally assign 'F' or 'C' here if allowed by rules?
                            // Or let validation handle it.
                        }
                     }
                 } catch (e) {
                      console.warn(`Skipping invalid fixed day off date for ${employee.name}: ${dateOff}`)
                 }
            })
         }

        // Apply Fixed Work Shift (e.g., Alamo works M on Weekdays)
         if (prefs.fixedWorkShift) {
            const { dayOfWeek: daysOfWeek, shift } = prefs.fixedWorkShift;
            // Ensure daysOfWeek is an array before proceeding
            if(Array.isArray(daysOfWeek) && shift) {
                schedule.days.forEach(day => {
                    // Assign fixed shift only if the slot is currently empty (respecting LAO/LM)
                     if (day.shifts[employee.id] === null) {
                         const currentDate = parseISO(day.date);
                         const currentDayOfWeek = getDay(currentDate); // Sunday = 0, Saturday = 6
                         if (daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday) {
                             day.shifts[employee.id] = shift;
                         }
                     }
                     // Additionally, ensure they DON'T work M/T on their non-fixed days if the slot is still empty
                     else if (day.shifts[employee.id] === null && !day.isHoliday) {
                         const currentDate = parseISO(day.date);
                         const currentDayOfWeek = getDay(currentDate);
                         if (!daysOfWeek.includes(currentDayOfWeek)) {
                              // If it's not their designated workday, they shouldn't work M/T.
                              // We can assign D or C here if needed, or let the main assignment logic handle it.
                              // For now, we let the main logic fill it, `canWorkShift` should prevent M/T assignment later.
                         }
                     }
                })
            }
         }
    });
}


// Calculates consecutive work days *ending* on the day *before* dateStr
function getConsecutiveWorkDaysBefore(employeeId: number, dateStr: string, schedule: Schedule, employees: Employee[]): number {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) return 0;

    let consecutiveDays = 0;
    let currentDate: Date;
     try {
       currentDate = subDays(parseISO(dateStr), 1); // Start checking from the day before
       if (!isValid(currentDate)) return 0; // Invalid input date
     } catch (e) {
        return 0; // Error parsing input date
     }


    // Check current schedule backwards
    const scheduleStartDate = parseISO(schedule.days[0].date);
    while (currentDate >= scheduleStartDate) {
        const currentDayStr = format(currentDate, 'yyyy-MM-dd');
        const daySchedule = schedule.days.find(d => d.date === currentDayStr);
        const shift = daySchedule?.shifts[employeeId];

        if (shift === 'M' || shift === 'T') {
            consecutiveDays++;
        } else {
            // Any non-work shift (D, C, F, LAO, LM, or null initially) breaks the streak
            return consecutiveDays;
        }
        currentDate = subDays(currentDate, 1);
    }

    // If we reach the beginning of the schedule, check history
    const history = employee.history || {};
    const historyDates = Object.keys(history).sort().reverse(); // Sort recent first

    for(const histDateStr of historyDates){
         try {
             const histDate = parseISO(histDateStr);
              if (!isValid(histDate)) continue; // Skip invalid history dates

              if(format(currentDate, 'yyyy-MM-dd') !== histDateStr) {
                 // If the history date doesn't match the expected previous day, the streak is broken by a gap
                 // console.log(`Streak break due to gap: Expected ${format(currentDate, 'yyyy-MM-dd')}, found history ${histDateStr}`);
                  return consecutiveDays;
              };
             const shift = history[histDateStr];
              if (shift === 'M' || shift === 'T') {
                 consecutiveDays++;
                 currentDate = subDays(currentDate, 1); // Move to the next day to check in history
             } else {
                 // Streak broken in history
                 // console.log(`Streak break in history: Non-work shift ${shift} on ${histDateStr}`);
                 return consecutiveDays;
             }
         } catch (e) {
              console.warn(`Error parsing history date ${histDateStr} for employee ${employee.name}. Skipping.`);
              return consecutiveDays; // Stop checking history on error
         }
    }
    // console.log(`Final consecutive days for ${employee.name} before ${dateStr}: ${consecutiveDays}`);
    return consecutiveDays;
}


function canWorkShift(employee: Employee, dateStr: string, shift: ShiftType, schedule: Schedule, employees: Employee[]): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    // Allow checking possibility even if shift is assigned (e.g., for validation or backtracking)
    // if (!day || day.shifts[employee.id] !== null) return false;
     if (!day) return false; // Day not found

     // Cannot assign if already LAO or LM (highest priority)
     if (day.shifts[employee.id] === 'LAO' || day.shifts[employee.id] === 'LM') {
         return false;
     }


    // Prio 5: Max Consecutive Days
    // Check if *adding* this work shift would exceed the limit
    if ((shift === 'M' || shift === 'T')) {
        const consecutiveBefore = getConsecutiveWorkDaysBefore(employee.id, dateStr, schedule, employees);
        if (consecutiveBefore >= MAX_CONSECUTIVE_WORK_DAYS) {
             // console.log(`Consecutive day violation for ${employee.name} on ${dateStr} (would be ${consecutiveBefore + 1})`);
             return false;
        }
    }

    // Prio 3: Cannot assign 'D' on a holiday
    if (shift === 'D' && day.isHoliday) {
        return false;
    }


    // Prio 1/Flexible: Check fixed assignments/days off from preferences
    const prefs = employee.preferences || {};
    // Check if there's a conflicting fixed assignment
    if (prefs.fixedAssignments?.some(a => a.date === dateStr && a.shift !== shift)) {
         return false; // Fixed assignment exists for this day with a *different* shift
     }
     // Check if trying to assign work (M/T) on a fixed day off
     if (prefs.fixedDaysOff?.includes(dateStr) && (shift === 'M' || shift === 'T')) {
          return false; // Cannot assign M/T on a day fixed as 'D'
      }
      // Check if trying to assign non-'D' shift on a fixed day off (unless it's F on holiday?)
      if (prefs.fixedDaysOff?.includes(dateStr) && shift !== 'D') {
          // Allow F if it's a holiday and a fixed day off? Or prioritize fixed D?
          // Current logic: fixed Day Off means ONLY D (unless holiday overrides)
           if (!(shift === 'F' && day.isHoliday)) { // Allow F on holiday even if fixed D was set? Debateable.
               return false;
           }
      }

      // Fixed Work Shift (e.g., Alamo)
       if(prefs.fixedWorkShift){
         const { dayOfWeek: daysOfWeek, shift: fixedShift } = prefs.fixedWorkShift;
         if(Array.isArray(daysOfWeek) && fixedShift) {
             const currentDayOfWeek = getDay(parseISO(dateStr));
             const requiresFixedShift = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

             if(requiresFixedShift && shift !== fixedShift){
                 // Trying to assign something other than the required fixed shift on a designated workday
                 return false;
             }
             if(!requiresFixedShift && (shift === 'M' || shift === 'T') && !day.isHoliday){
                 // Trying to assign M or T on a day that *isn't* the fixed work day
                  return false;
             }
         }
       }


    // Flexible 1: T -> M Rest Check (12h rule approximation)
    // Check the shift on the *previous* day
    if (shift === 'M') {
        const prevDate = subDays(parseISO(dateStr), 1);
        const prevDateStr = format(prevDate, 'yyyy-MM-dd');
        const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
        let prevShift: ShiftType | null = null;

        if (prevDaySchedule) {
            prevShift = prevDaySchedule.shifts[employee.id];
        } else {
            // Check history if it's the first day of the month
             prevShift = employee.history?.[prevDateStr] || null;
        }

        if (prevShift === 'T') {
            // console.log(`Potential T->M violation for ${employee.name} on ${dateStr}. Allowing for now, validation will flag.`);
            // return false; // Make this strict if T->M is absolutely forbidden - Currently treated as flexible.
        }
    }

    // Flexible Preferences (e.g., Forni) - Lower priority checks
      // These act as blockers only if the preference is strong.
      // Example: Forni prefers Weekend Work - block assigning D/C/F on weekends?
       if (prefs.preferWeekendWork && (shift === 'D' || shift === 'C' || shift === 'F') && day.isWeekend) {
            // console.log(`Flex conflict: ${employee.name} prefers weekend work, blocking ${shift} on ${dateStr}`);
            // return false; // Make this a hard block if preference is strong
       }
       // Example: Forni prefers Monday Rest - block assigning M/T on non-holiday Mondays?
       if (prefs.preferMondayRest && (shift === 'M' || shift === 'T') && getDay(parseISO(dateStr)) === 1 && !day.isHoliday) {
            // console.log(`Flex conflict: ${employee.name} prefers Monday rest, blocking ${shift} on ${dateStr}`);
            // return false; // Make this a hard block if preference is strong
       }
        // Example: Forni prefers Thursday T - block assigning M on non-holiday Thursdays?
       if (prefs.preferThursdayT && shift === 'M' && getDay(parseISO(dateStr)) === 4 && !day.isHoliday) {
            // console.log(`Flex conflict: ${employee.name} prefers Thursday T, blocking ${shift} on ${dateStr}`);
            // return false; // Make this a hard block if preference is strong
       }

    // Add other preference checks here if needed

    return true;
}

// --- Global Employee Data (needed for stateful updates within generation scope) ---
// This approach is simpler than passing the mutable employees array everywhere.
// It's reset at the start of each generateSchedule call.
let currentEmployeesState: Employee[] = [];

function assignShift(employeeId: number, dateStr: string, shift: ShiftType, schedule: Schedule) {
  const day = schedule.days.find(d => d.date === dateStr);
  // Allow overwriting null or previously generated shifts (like D/C/F) but not LAO/LM or fixed shifts
  const currentShift = day?.shifts[employeeId];
  const isFixed = currentEmployeesState.find(e=>e.id === employeeId)?.preferences?.fixedAssignments?.some(a=>a.date === dateStr);

  // Assign if the slot is null, or if it's not a high-priority locked shift (LAO/LM)
   if (day && (!currentShift || (currentShift !== 'LAO' && currentShift !== 'LM')) ) {
       // Check if overwriting a different fixed assignment (should be blocked by canWorkShift, but double check)
       if(currentShift && isFixed && currentShift !== shift) {
            console.warn(`Attempting to overwrite fixed shift ${currentShift} with ${shift} for employee ${employeeId} on ${dateStr}. Allowing, but check logic.`);
       }
       day.shifts[employeeId] = shift;

       // --- Important: Update totals in calculateFinalTotals AFTER all assignments ---
       // Avoid double counting if assignment logic runs multiple passes or backtracks.
   } else if(day && currentShift) {
       // console.warn(`Assignment blocked for employee ${employeeId} on ${dateStr}. Current shift: ${currentShift}, Attempted: ${shift}`);
   }
}


function calculateFinalTotals(schedule: Schedule, employees: Employee[]) {
 // Reset daily totals before recalculating
  schedule.days.forEach(day => {
    day.totals = { M: 0, T: 0, D: 0, C: 0, F: 0, LM: 0, LAO: 0, TPT: 0 };
  });
  // Reset employee totals before recalculating
   employees.forEach(emp => {
        schedule.employeeTotals[emp.id] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, C: 0, D: 0, LM: 0, LAO: 0 };
   });


  const numDaysInMonth = schedule.days.length;

  schedule.days.forEach(day => {
    let date: Date;
    try {
        date = parseISO(day.date);
        if (!isValid(date)) throw new Error('Invalid date');
    } catch (e) {
        console.error(`Error parsing date for totals calculation: ${day.date}`);
        return; // Skip this day if date is invalid
    }

    const dayOfWeek = getDay(date); // 0 = Sunday, 6 = Saturday

    Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
        const empId = parseInt(empIdStr);
        const empTotals = schedule.employeeTotals[empId];
        if (!empTotals) {
            console.warn(`Employee totals not found for ID ${empId} during final calculation.`);
            schedule.employeeTotals[empId] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, C: 0, D: 0, LM: 0, LAO: 0 }; // Initialize if missing
            // return; // Or just initialize and continue
        }


        if (shift === 'M') { day.totals.M++; empTotals.M++; empTotals.workedDays++; }
        else if (shift === 'T') { day.totals.T++; empTotals.T++; empTotals.workedDays++; }
        else if (shift === 'D') { day.totals.D++; empTotals.D++; }
        else if (shift === 'C') { day.totals.C++; empTotals.C++; }
        else if (shift === 'F') { day.totals.F++; empTotals.F++; }
        else if (shift === 'LM') { day.totals.LM++; empTotals.LM++; }
        else if (shift === 'LAO') { day.totals.LAO++; empTotals.LAO++; }

         // Check free weekends based on final assignment
         // Only count as free if not M or T (D, C, F, LM, LAO count as free for weekend purposes)
         if (dayOfWeek === 6 && shift !== 'M' && shift !== 'T') empTotals.freeSaturdays++;
         if (dayOfWeek === 0 && shift !== 'M' && shift !== 'T') empTotals.freeSundays++;

    });
     day.totals.TPT = day.totals.M + day.totals.T;
  });

   // Verification log for employee total days
    employees.forEach(emp => {
         const totals = schedule.employeeTotals[emp.id];
         if (!totals) {
             console.warn(`Totals missing for employee ${emp.name} (${emp.id}) during final verification.`);
             return;
         }
         const totalAssigned = totals.workedDays + totals.C + totals.D + totals.F + totals.LM + totals.LAO;
         if(totalAssigned !== numDaysInMonth){
            // Changed to warn as this might reflect generator limitations not finding assignments for all days,
            // rather than a strict calculation error.
            console.warn(`ALERT: Employee ${emp.name} (${emp.id}) total days mismatch. Assigned: ${totalAssigned}, Month Days: ${numDaysInMonth}. (May indicate unassigned days)`);
            // console.log("Employee Totals:", totals)
            // const empShifts = schedule.days.map(d => `${d.date}: ${d.shifts[emp.id] ?? 'NULL'}`).join(' | ');
            // console.log(`Shifts for ${emp.name}: ${empShifts}`)
         }
    });
}


function validateSchedule(schedule: Schedule, employees: Employee[], holidays: Holiday[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const employeeMap = new Map(employees.map(e => [e.id, e]));

  // --- Priority Rules ---

  // Prio 1: Absences & Fixed Assignments (Implicitly checked by application, but verify)
  // Example: Verify LAO/LM are still set correctly
   absences.forEach(absence => {
        const employee = employeeMap.get(absence.employeeId);
        if (!employee) return;
        try {
           const startDate = parseISO(absence.startDate);
           const endDate = parseISO(absence.endDate);
           if (!isValid(startDate) || !isValid(endDate)) return;

           schedule.days.forEach(day => {
               const currentDate = parseISO(day.date);
               if (currentDate >= startDate && currentDate <= endDate) {
                   if (day.shifts[absence.employeeId] !== absence.type) {
                       results.push({
                           rule: `Priority 1 - Absence Override (${employee.name} on ${day.date})`,
                           passed: false,
                           details: `Failed: Expected ${absence.type}, found ${day.shifts[absence.employeeId]}`,
                       });
                   }
               }
           });
        } catch (e) { /* ignore date parsing errors here, handled elsewhere */ }
   });
   // Example: Verify fixed assignments
    employees.forEach(emp => {
        emp.preferences?.fixedAssignments?.forEach(fixed => {
            const day = schedule.days.find(d => d.date === fixed.date);
            if (day && day.shifts[emp.id] !== fixed.shift && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') { // Allow LAO/LM to override
                 results.push({
                    rule: `Priority 1 - Fixed Assignment (${emp.name} on ${fixed.date})`,
                    passed: false,
                    details: `Failed: Expected ${fixed.shift}, found ${day.shifts[emp.id]}`,
                 });
            }
        });
         emp.preferences?.fixedDaysOff?.forEach(fixedD => {
             const day = schedule.days.find(d => d.date === fixedD);
              if (day && day.shifts[emp.id] !== 'D' && day.shifts[emp.id] !== 'F' && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') { // Allow F on holiday, LAO/LM to override fixed D
                  results.push({
                     rule: `Priority 1 - Fixed Day Off (${emp.name} on ${fixedD})`,
                     passed: false,
                     details: `Failed: Expected D, found ${day.shifts[emp.id]}`,
                  });
             }
         });
    });

   if (!results.some(r => r.rule.startsWith("Priority 1"))) {
       results.push({ rule: `Priority 1 - Absences/Fixed (Overall)`, passed: true, details: 'Passed'});
   }

  // Prio 2: Coverage & M/T Ratio
  schedule.days.forEach(day => {
    const { M, T, TPT } = day.totals;
    let rule2Passed = true;
    let details = [];

    if (TPT < MIN_COVERAGE_TPT) {
      rule2Passed = false;
      details.push(`TPT=${TPT} (Req: >=${MIN_COVERAGE_TPT})`);
    }
    // Separate checks for M and T minimums
    if (M < MIN_COVERAGE_M) {
        rule2Passed = false;
        details.push(`M=${M} (Req: >=${MIN_COVERAGE_M})`);
    }
    if (T < MIN_COVERAGE_T) {
         rule2Passed = false;
        details.push(`T=${T} (Req: >=${MIN_COVERAGE_T})`);
    }
    // M > T rule for non-holiday/non-weekend days when TPT > 2
    if (TPT > MIN_COVERAGE_TPT && !day.isHoliday && !day.isWeekend && M <= T) {
        rule2Passed = false;
        details.push(`M=${M}, T=${T} on std. workday (Req: M>T if TPT>${MIN_COVERAGE_TPT})`);
    }

    if(!rule2Passed) {
        results.push({
          rule: `Priority 2 - Coverage/Ratio (${format(parseISO(day.date), 'dd/MM')})`,
          passed: false,
          details: `Failed: ${details.join(', ')}`,
        });
    }
  });
   // Add an overall pass if no Prio 2 errors were found
  if (!results.some(r => r.rule.startsWith("Priority 2"))) {
       results.push({ rule: `Priority 2 - Coverage/Ratio (Overall)`, passed: true, details: 'Passed'});
   }


  // Prio 3: Exact Descansos (D) if specified & D not on Holiday
   Object.entries(REQUIRED_D_COUNT_BY_NAME).forEach(([name, requiredDs]) => {
       const employee = employees.find(e => e.name === name);
       if (employee && schedule.employeeTotals[employee.id]) { // Check if totals exist
           const actualDs = schedule.employeeTotals[employee.id].D ?? 0;
           const passed = actualDs === requiredDs;
            if(!passed){
               results.push({
                   rule: `Priority 3 - Exact D Count (${name})`,
                   passed: false,
                   details: `Failed: Has ${actualDs}, requires ${requiredDs}`,
               });
            }
       } else if (employee && !schedule.employeeTotals[employee.id]) {
           console.warn(`Totals not found for ${name} during Prio 3 validation.`);
       }
   });
    // Check D not on Holiday
    let dOnHolidayFound = false;
    schedule.days.forEach(day => {
        if(day.isHoliday){
            Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
                 if(shift === 'D'){
                     const empId = parseInt(empIdStr);
                     const employee = employeeMap.get(empId);
                      results.push({
                         rule: `Priority 3 - D on Holiday (${employee?.name || empIdStr} on ${format(parseISO(day.date), 'dd/MM')})`,
                         passed: false,
                         details: `Failed: ${employee?.name || `Emp ${empId}`} has D on holiday ${day.date}`,
                     });
                     dOnHolidayFound = true;
                 }
            })
        }
    });
      // Add overall pass if no Prio 3 errors
     if (!results.some(r => r.rule.startsWith("Priority 3"))) {
       results.push({ rule: `Priority 3 - Descansos (Overall)`, passed: true, details: 'Passed'});
     }


  // Prio 4: D/D Weekends
  let anyPrio4Fail = false;
  employees.forEach(emp => {
    if (!emp.eligibleWeekend) return; // Skip ineligible employees
    let ddWeekends = 0;
    for (let i = 0; i < schedule.days.length - 1; i++) {
      const day1 = schedule.days[i];
      const day2 = schedule.days[i + 1];
      try {
        const date1 = parseISO(day1.date);
        const date2 = parseISO(day2.date);
        if (!isValid(date1) || !isValid(date2)) continue;

         // Check if it's a Saturday and Sunday pair
         if (getDay(date1) === 6 && getDay(date2) === 0) {
           if ((day1.shifts[emp.id] === 'D' || day1.shifts[emp.id] === 'F') && // Count F on Sat as part of D/D weekend? Yes.
               (day2.shifts[emp.id] === 'D' || day2.shifts[emp.id] === 'F')) { // Count F on Sun as part of D/D weekend? Yes.
             ddWeekends++;
           }
         }
      } catch(e){ continue; } // Ignore date parsing errors
    }
     const passed = ddWeekends >= REQUIRED_DD_WEEKENDS;
     if (!passed) {
         results.push({
           rule: `Priority 4 - D/D Weekend (${emp.name})`,
           passed: false,
           details: `Failed: Has ${ddWeekends} (D/D or D/F or F/D or F/F), requires ${REQUIRED_DD_WEEKENDS}`,
         });
         anyPrio4Fail = true;
     }
  });
    if (!anyPrio4Fail && employees.some(e => e.eligibleWeekend)) { // Only pass if someone was eligible
       results.push({ rule: `Priority 4 - D/D Weekend (Overall)`, passed: true, details: 'Passed'});
   } else if (!employees.some(e => e.eligibleWeekend)) {
        results.push({ rule: `Priority 4 - D/D Weekend (Overall)`, passed: true, details: 'N/A (No employees eligible)'});
   }


   // Prio 5: Max Consecutive Days
   let maxConsecutiveOverall = 0;
   let maxConsecutiveEmployee = '';
   let prio5PassedOverall = true;

   employees.forEach(emp => {
       let currentConsecutive = 0;
       let maxForEmployee = 0;

       // Start by checking history
       const initialConsecutive = getConsecutiveWorkDaysBefore(emp.id, schedule.days[0].date, schedule, employees);
       currentConsecutive = initialConsecutive;
       maxForEmployee = initialConsecutive;

       // Iterate through the generated schedule
       schedule.days.forEach(day => {
           const shift = day.shifts[emp.id];
           if (shift === 'M' || shift === 'T') {
               currentConsecutive++;
           } else {
                // Only reset if it's a non-work day (D, C, F, LAO, LM) OR null/undefined
                if (shift !== 'M' && shift !== 'T') {
                   maxForEmployee = Math.max(maxForEmployee, currentConsecutive);
                   currentConsecutive = 0; // Reset counter
                }
                 // If shift is null, the streak might continue from previous day, don't reset yet.
                 // The final max check below handles streaks ending at the end.
           }
       });
       // Final check for streak ending at the end of the month
        maxForEmployee = Math.max(maxForEmployee, currentConsecutive);

         if(maxForEmployee > maxConsecutiveOverall){
             maxConsecutiveOverall = maxForEmployee;
             maxConsecutiveEmployee = emp.name;
         }

         if (maxForEmployee > MAX_CONSECUTIVE_WORK_DAYS) {
            // Only report failure if the employee actually has shifts assigned
            if(schedule.employeeTotals[emp.id]?.workedDays > 0 || schedule.employeeTotals[emp.id]?.M > 0 || schedule.employeeTotals[emp.id]?.T > 0) {
                 results.push({
                     rule: `Priority 5 - Max Consecutive Days (${emp.name})`,
                     passed: false,
                     details: `Failed: Worked ${maxForEmployee} consecutive days (Max ${MAX_CONSECUTIVE_WORK_DAYS})`,
                 });
                 prio5PassedOverall = false;
             }
         }
   });
     // Add one overall result for Prio 5
    results.push({
        rule: `Priority 5 - Max Consecutive Days (Overall)`,
        passed: prio5PassedOverall,
        details: prio5PassedOverall
            ? `Passed (Max found: ${maxConsecutiveOverall})`
            : `Failed (Max found: ${maxConsecutiveOverall} by ${maxConsecutiveEmployee || 'N/A'})`,
    });


  // --- Flexible Rules Validation ---
    // Flex 1: T->M Rest
    let t_m_violations = 0;
    let t_m_details: string[] = [];
     employees.forEach(emp => {
         for (let i = 0; i < schedule.days.length; i++) {
              try {
                 const currentDayDateStr = schedule.days[i].date;
                 const currentShift = schedule.days[i].shifts[emp.id];

                 if (currentShift === 'M') {
                      const prevDate = subDays(parseISO(currentDayDateStr), 1);
                      const prevDateStr = format(prevDate, 'yyyy-MM-dd');
                      const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
                      let prevShift: ShiftType | null = null;
                      if (prevDaySchedule) {
                          prevShift = prevDaySchedule.shifts[emp.id];
                      } else {
                          prevShift = emp.history?.[prevDateStr] || null;
                      }

                     if (prevShift === 'T') {
                        t_m_violations++;
                        t_m_details.push(`${emp.name} on ${format(parseISO(currentDayDateStr), 'dd/MM')}`);
                     }
                 }
              } catch (e) { /* Ignore date parsing errors */ }
         }
     })
      results.push({
        rule: `Flexible 1 - T->M 12h Rest`,
        // Consider this "passed" even with violations, as it's flexible
        passed: true,
        details: t_m_violations === 0 ? 'No violations detected' : `Potential Violations: ${t_m_violations} instance(s) (${t_m_details.slice(0, 3).join(', ')}${t_m_violations > 3 ? '...' : ''})`,
    });


    // Flex 4: Target Staffing (Deviation)
    let staffingDeviations = 0;
     schedule.days.forEach(day => {
        const { M, T } = day.totals;
        const isWorkDay = !day.isHoliday && !day.isWeekend;
        const targetM = isWorkDay ? TARGET_M_WORKDAY : TARGET_M_WEEKEND_HOLIDAY;
        const targetT = TARGET_T; // Always 1

         if(M !== targetM || T !== targetT) {
             staffingDeviations++;
             // Don't log every single day's deviation, just summarize overall
             // results.push({
             //     rule: `Flexible 4 - Target Staffing (${format(parseISO(day.date), 'dd/MM')})`,
             //     passed: true, // Flexible - report deviation, not failure
             //     details: `Deviation: Actual M=${M}, T=${T} (Target M=${targetM}, T=${targetT})`,
             // });
         }
     })
      results.push({
          rule: `Flexible 4 - Target Staffing (Overall)`,
          passed: true,
          details: staffingDeviations === 0 ? 'All days met target staffing.' : `${staffingDeviations} day(s) deviated from target staffing.`,
      });


    // Flex 5: M/T Balance (Employee Level)
    let balanceIssues = 0;
     employees.forEach(emp => {
        if (!schedule.employeeTotals[emp.id]) return; // Skip if no totals
         // Skip employees with fixed schedules like Alamo if they shouldn't be balanced
         if(emp.preferences?.fixedWorkShift) return;

         const { M, T } = schedule.employeeTotals[emp.id] ?? { M: 0, T: 0 };
         const totalShifts = M + T;
         if (totalShifts > 0) {
             const diff = Math.abs(M - T);
             // Define a threshold for 'imbalance', e.g., difference > 4 shifts or percentage based
             const imbalanceThreshold = Math.max(2, Math.floor(totalShifts * 0.25)); // Example: diff > 2 or 25%
             if (diff > imbalanceThreshold) {
                balanceIssues++;
                 // Don't log every imbalance, just summarize
                 // results.push({
                 //     rule: `Flexible 5 - M/T Balance (${emp.name})`,
                 //     passed: true, // Flexible rule
                 //     details: `Potential Imbalance: M=${M}, T=${T} (Difference: ${diff})`,
                 // });
             }
         }
     });
       results.push({
           rule: `Flexible 5 - M/T Balance (Overall)`,
           passed: true,
           details: balanceIssues === 0 ? 'Employee M/T counts appear balanced.' : `${balanceIssues} employee(s) show potential M/T imbalance.`,
       });

    // Flex 6 & 7: Specific Preferences Check (e.g., Forni)
    employees.forEach(emp => {
        // Example check for Forni
        if (emp.preferences?.preferWeekendWork || emp.preferences?.preferMondayRest || emp.preferences?.preferThursdayT) {
            const prefs = emp.preferences;
            let violations: string[] = [];
            schedule.days.forEach(day => {
                try {
                     const shift = day.shifts[emp.id];
                     if (!shift) return; // Skip unassigned shifts

                     const date = parseISO(day.date);
                     if (!isValid(date)) return;
                     const dayOfWeek = getDay(date);

                      // Check Weekend Work Pref (If pref = true, violation if D/C/F on weekend)
                     if (prefs.preferWeekendWork && (shift === 'D' || shift === 'C' || shift === 'F') && day.isWeekend) violations.push(`Franco/Libre on preferred work weekend ${format(date, 'dd/MM')}`);
                      // Check Monday Rest Pref (If pref = true, violation if M/T on Mon)
                     if (prefs.preferMondayRest && (shift === 'M' || shift === 'T') && dayOfWeek === 1 && !day.isHoliday) violations.push(`Worked on preferred rest Monday ${format(date, 'dd/MM')}`);
                      // Check Thursday T Pref (If pref = true, violation if M on Thu)
                     if (prefs.preferThursdayT && shift === 'M' && dayOfWeek === 4 && !day.isHoliday) violations.push(`Worked M on preferred T Thursday ${format(date, 'dd/MM')}`);
                } catch (e) { /* Ignore date errors */ }
            })
             if (violations.length > 0) {
                results.push({
                    rule: `Flexible Preference - ${emp.name}`,
                    passed: true, // Flexible
                    details: `Preference Mismatches: ${violations.slice(0,2).join(', ')}${violations.length > 2 ? '...' : ''}`
                });
            }
        }
        // Add checks for other specific employee preferences here
    });

    // Final check: Ensure every slot is filled (unless LAO/LM)
    let unassignedCount = 0;
    schedule.days.forEach(day => {
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                unassignedCount++;
            }
        })
    });
     if (unassignedCount > 0) {
        results.push({
            rule: "Completeness Check",
            passed: false,
            details: `Failed: ${unassignedCount} employee-day slots remain unassigned.`,
        });
    } else {
         results.push({
            rule: "Completeness Check",
            passed: true,
            details: `Passed: All employee-day slots assigned.`,
        });
    }


    // Ensure results are sorted by priority (approximate) then alphabetically
    results.sort((a, b) => {
         const getPrio = (rule: string): number => {
              if (rule.includes("Completeness Check")) return 0; // Highest importance
             if (rule.includes("Priority 1")) return 1;
             if (rule.includes("Priority 2")) return 2;
             if (rule.includes("Priority 3")) return 3;
             if (rule.includes("Priority 4")) return 4;
             if (rule.includes("Priority 5")) return 5;
             if (rule.includes("Flexible 1")) return 6; // T->M
             if (rule.includes("Flexible 5")) return 7; // Balance
             if (rule.includes("Flexible 4")) return 8; // Staffing Target
             if (rule.includes("Flexible Preference")) return 9; // Specific Prefs
             if (rule.includes("Flexible")) return 10; // Other Flexible
             return 11; // Other/Error rules
         }
         const prioA = getPrio(a.rule);
         const prioB = getPrio(b.rule);
         if (prioA !== prioB) return prioA - prioB;
         // If same priority, sort by pass/fail (failures first), then alphabetically
          if (a.passed !== b.passed) return a.passed ? 1 : -1;
         return a.rule.localeCompare(b.rule);
     });


  return results;
}


// --- Core Assignment Logic (Recursive Backtracking - Conceptual Outline) ---

// function solveSchedule(dayIndex: number, schedule: Schedule, employees: Employee[]): boolean {
//     if (dayIndex >= schedule.days.length) {
//         return true; // Reached end of month, solution found (check validation later)
//     }
//
//     const day = schedule.days[dayIndex];
//     const employeesToAssign = employees.filter(emp => day.shifts[emp.id] === null);
//
//     // Try assigning shifts for each employee on this day
//     function tryAssignmentsForEmployee(empIndex: number): boolean {
//          if (empIndex >= employeesToAssign.length) {
//              // All employees assigned for this day, check day's constraints (coverage, M/T ratio)
//              if (!isDayCoverageValid(day)) { // Function to check TPT, M>=1, T>=1, M>T rule
//                 return false;
//              }
//              // Move to the next day
//             return solveSchedule(dayIndex + 1, schedule, employees);
//         }
//
//         const employee = employeesToAssign[empIndex];
//         const possibleShifts: ShiftType[] = ['M', 'T', 'D']; // Add C, F based on rules/holidays
//          if (day.isHoliday) { // Only F is typically assigned automatically if free on holiday
//              possibleShifts.push('F');
//          } else {
//               possibleShifts.push('C'); // Can C be assigned? Depends on rules
//          }
//
//         for (const shift of possibleShifts) {
//              // Check if this assignment is valid based on ALL constraints known so far
//              // (Consecutive days, T->M, specific D count, D/D weekend goal, etc.)
//             if (canWorkShift(employee, day.date, shift, schedule, employees) /* && meetsOtherConstraints(...) */ ) {
//                 assignShift(employee.id, day.date, shift, schedule);
//
//                 // Recurse for the next employee on the *same* day
//                 if (tryAssignmentsForEmployee(empIndex + 1)) {
//                     return true; // Found a valid path forward
//                 }
//
//                 // Backtrack: Reset the assignment and try the next shift
//                 day.shifts[employee.id] = null;
//                 // Need to reset totals if they were updated in assignShift
//             }
//         }
//         // No valid shift found for this employee on this day with current assignments
//         return false;
//     }
//
//     return tryAssignmentsForEmployee(0);
// }


// --- Simplified Iterative Assignment (Placeholder - less robust than backtracking) ---
function iterativeAssignShifts(schedule: Schedule, employees: Employee[]) {

    // --- Pass 1: Assign Essential Coverage (M & T) respecting constraints ---
    console.log("Starting Pass 1: Essential Coverage (M/T)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        let assignedInDay = { M: 0, T: 0 }; // Track assignments *in this pass* for the day
        Object.values(day.shifts).forEach(s => { // Count pre-assigned (LAO/LM/Fixed)
            if (s === 'M') assignedInDay.M++;
            if (s === 'T') assignedInDay.T++;
        });

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null); // Only consider unassigned

        const assignShiftIfPossible = (shiftType: 'M' | 'T'): boolean => {
             // Sort candidates: prioritize those who *can* work, maybe less flexible ones first?
             // Or prioritize those needing shifts for balance? Simple sort for now.
            const candidates = availableEmployees
                .filter(e => canWorkShift(e, dateStr, shiftType, schedule, employees))
                // Sort: prioritize employees with fewer shifts of this type so far?
                // Requires temporary running totals or rely on final balance check.
                // Sort by ID for deterministic behavior for now.
                .sort((a, b) => a.id - b.id);

            if (candidates.length > 0) {
                assignShift(candidates[0].id, dateStr, shiftType, schedule);
                assignedInDay[shiftType]++;
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id); // Update available list
                // console.log(`Assigned ${shiftType} to ${candidates[0].name} on ${dateStr}`);
                return true;
            }
            // console.log(`Could not assign ${shiftType} on ${dateStr}`);
            return false;
        };

        // 1a: Ensure Min M >= 1
        while (assignedInDay.M < MIN_COVERAGE_M) {
            if (!assignShiftIfPossible('M')) break; // Stop if no one can work M
        }
        // 1b: Ensure Min T >= 1
        while (assignedInDay.T < MIN_COVERAGE_T) {
            if (!assignShiftIfPossible('T')) break; // Stop if no one can work T
        }
        // 1c: Ensure Min TPT >= 2
        while (assignedInDay.M + assignedInDay.T < MIN_COVERAGE_TPT) {
            // Try assigning M first (often preferred or needed for M>T rule)
            if (assignShiftIfPossible('M')) continue;
            // If M fails, try assigning T
            if (assignShiftIfPossible('T')) continue;
            // If neither works, break and report failure later
            console.warn(`Could not meet TPT >= ${MIN_COVERAGE_TPT} on ${dateStr}. Current M=${assignedInDay.M}, T=${assignedInDay.T}`);
            break;
        }

        // 1d: Enforce M > T rule (if TPT > 2 and not weekend/holiday)
        if (assignedInDay.M + assignedInDay.T > MIN_COVERAGE_TPT && !day.isWeekend && !day.isHoliday) {
            while (assignedInDay.M <= assignedInDay.T) {
                 // console.log(`Attempting to enforce M>T on ${dateStr} (M=${assignedInDay.M}, T=${assignedInDay.T})`);
                if (!assignShiftIfPossible('M')) {
                     console.warn(`Could not enforce M > T rule on ${dateStr}. No more available M shifts.`);
                    break; // Cannot assign more M, rule will fail validation
                }
            }
        }

    });

    // --- Pass 2: Assign Preferred/Target Shifts (Flexible) ---
    // Example: Try to reach target staffing (3M/1T workday, 2M/1T weekend/holiday)
    console.log("Starting Pass 2: Preferred/Target Staffing");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        let currentM = Object.values(day.shifts).filter(s => s === 'M').length;
        let currentT = Object.values(day.shifts).filter(s => s === 'T').length;
        const targetM = day.isWeekend || day.isHoliday ? TARGET_M_WEEKEND_HOLIDAY : TARGET_M_WORKDAY;
        const targetT = TARGET_T;

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null);

         // Add M shifts up to target
         while (currentM < targetM) {
             const candidates = availableEmployees
                 .filter(e => canWorkShift(e, dateStr, 'M', schedule, employees))
                 .sort((a, b) => a.id - b.id); // Simple sort
             if (candidates.length === 0) break;
             assignShift(candidates[0].id, dateStr, 'M', schedule);
             currentM++;
             availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
         }

         // Add T shifts up to target
         while (currentT < targetT) {
             const candidates = availableEmployees
                 .filter(e => canWorkShift(e, dateStr, 'T', schedule, employees))
                 .sort((a, b) => a.id - b.id); // Simple sort
             if (candidates.length === 0) break;
             assignShift(candidates[0].id, dateStr, 'T', schedule);
             currentT++;
             availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
         }
    });


    // --- Pass 3: Assign Remaining Non-Work Shifts (D, F, C) ---
    console.log("Starting Pass 3: Assign Rests (D, F, C)");
    schedule.days.forEach(day => {
         const dateStr = day.date;
         employees.forEach(emp => {
             if (day.shifts[emp.id] === null) { // If still unassigned
                 let assignedRest = false;
                 // Prio 3/Holiday: Assign F if it's a holiday and they *can* have F
                 if (day.isHoliday) {
                     if (canWorkShift(emp, dateStr, 'F', schedule, employees)) {
                         assignShift(emp.id, dateStr, 'F', schedule);
                         assignedRest = true;
                         // console.log(`Assigned F to ${emp.name} on holiday ${dateStr}`);
                     } else {
                         // console.log(`Cannot assign F to ${emp.name} on holiday ${dateStr}, trying D...`);
                         // Fallback to D if F is not possible (e.g., consecutive day limit with history?)
                         // Note: Prio 3 technically forbids D on holiday, but maybe F is blocked?
                         if (canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                              // assignShift(emp.id, dateStr, 'D', schedule); // Allow D as fallback? NO, Prio 3 violation.
                              // assignedRest = true;
                              console.warn(`Could not assign F to ${emp.name} on holiday ${dateStr}, and D is forbidden. Leaving unassigned.`);
                         } else {
                              console.warn(`Could not assign F or D to ${emp.name} on holiday ${dateStr}. Leaving unassigned.`);
                         }
                     }
                 }

                  // Prio 3/4/Regular Day: Assign D if possible (respecting exact D count, D/D weekend needs)
                 if (!assignedRest && !day.isHoliday) {
                      // TODO: Add logic to check if employee needs D for Prio 3 or Prio 4
                      const needsD = true; // Placeholder - needs better logic based on remaining required D's / DD weekends
                      if (needsD && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                         assignShift(emp.id, dateStr, 'D', schedule);
                         assignedRest = true;
                         // console.log(`Assigned D to ${emp.name} on ${dateStr}`);
                      }
                 }

                  // Fallback: Assign C if nothing else worked (and if C is allowed)
                 if (!assignedRest && !day.isHoliday) {
                      if (canWorkShift(emp, dateStr, 'C', schedule, employees)) {
                         assignShift(emp.id, dateStr, 'C', schedule);
                         assignedRest = true;
                         // console.log(`Assigned C to ${emp.name} on ${dateStr}`);
                      }
                 }

                 // If still not assigned, log it. Validation will catch it.
                 if (!assignedRest && day.shifts[emp.id] === null) {
                      console.warn(`Could not assign any rest shift (D/F/C) to ${emp.name} on ${dateStr}. Slot remains empty.`);
                 }
             }
         });
     });

     // --- Pass 4: Final Check / Cleanup (Optional) ---
     // Could potentially iterate again to fill gaps or improve balance if complex rules were added.
}


// --- Main Exported Function ---

export function generateSchedule(
  year: number,
  month: number,
  initialEmployees: Employee[],
  absences: Absence[],
  holidays: Holiday[]
): { schedule: Schedule; report: ValidationResult[] } {

  console.log("Starting Schedule Generation for", { year, month });
  // Deep clone initial employees to avoid modifying the original array reference from the UI state
  const employeesForGeneration: Employee[] = JSON.parse(JSON.stringify(initialEmployees));
  // Reset/Initialize state for this run
  currentEmployeesState = employeesForGeneration; // Use the cloned array

  // 0. Initialize Schedule Structure
  const startTime = performance.now();
  const schedule = initializeSchedule(year, month, employeesForGeneration, holidays);
  console.log("Initialized schedule structure.");


  // 1. Apply Non-Negotiable Constraints First
  console.log("Applying absences...");
  applyAbsences(schedule, absences, employeesForGeneration);
  console.log("Applying fixed assignments/preferences...");
  applyFixedAssignments(schedule, employeesForGeneration); // Handles fixed shifts, days off

  // Log state after initial constraints
  // console.log("Schedule after initial constraints:", JSON.stringify(schedule.days.map(d => ({ date: d.date, shifts: d.shifts })), null, 2));


  // 2. Core Assignment Logic
  console.log("Starting iterative assignment passes...");
  iterativeAssignShifts(schedule, employeesForGeneration);
  console.log("Finished iterative assignment passes.");

  // Example call to a backtracking solver (if implemented):
  // const solved = solveSchedule(0, schedule, employeesForGeneration);
  // if (!solved) {
  //     console.error("Failed to find a valid schedule solution.");
       // Return the partially filled schedule and an error report
       // calculateFinalTotals(schedule, employeesForGeneration); // Calculate whatever was assigned
       // const report = validateSchedule(schedule, employeesForGeneration, holidays);
       // report.push({rule: "Generator Error", passed: false, details:"Could not find a complete valid assignment."});
       // return { schedule, report };
  // }


  // 3. Calculate Final Totals based on assignments
  console.log("Calculating final totals...");
  calculateFinalTotals(schedule, employeesForGeneration);

  // 4. Validate Final Schedule against all rules
  console.log("Validating final schedule...");
  const report = validateSchedule(schedule, employeesForGeneration, holidays);
  const endTime = performance.now();
  console.log(`Schedule generation completed in ${(endTime - startTime).toFixed(2)} ms`);

   // Add generation time to report (optional)
   report.push({ rule: "Generator Info", passed: true, details: `Generation took ${(endTime - startTime).toFixed(2)} ms` });

   // Sort report again just in case info was added out of order
    report.sort((a, b) => {
         const getPrio = (rule: string): number => {
             if (rule.includes("Completeness Check")) return 0;
             if (rule.includes("Priority 1")) return 1;
             if (rule.includes("Priority 2")) return 2;
             if (rule.includes("Priority 3")) return 3;
             if (rule.includes("Priority 4")) return 4;
             if (rule.includes("Priority 5")) return 5;
             if (rule.includes("Flexible 1")) return 6;
             if (rule.includes("Flexible 5")) return 7;
             if (rule.includes("Flexible 4")) return 8;
             if (rule.includes("Flexible Preference")) return 9;
             if (rule.includes("Flexible")) return 10;
             if (rule.includes("Generator Info")) return 12; // Add info at the end
             return 11;
         }
         const prioA = getPrio(a.rule);
         const prioB = getPrio(b.rule);
         if (prioA !== prioB) return prioA - prioB;
         if (a.passed !== b.passed) return a.passed ? 1 : -1;
         return a.rule.localeCompare(b.rule);
     });

  return { schedule, report };
}

