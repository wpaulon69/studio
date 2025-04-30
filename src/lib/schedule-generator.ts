
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
import { differenceInDays, format, parseISO, addDays, getDay, isWeekend, startOfMonth, endOfMonth, getDate, subDays } from 'date-fns';

// --- Constants and Configuration ---
const MAX_CONSECUTIVE_WORK_DAYS = 6;
const REQUIRED_DD_WEEKENDS = 1; // Minimum D/D weekends per eligible employee
const MIN_COVERAGE_TPT = 2;
const MIN_COVERAGE_M = 1;
const MIN_COVERAGE_T = 1;
// Define required D counts per employee NAME if applicable (Example)
const REQUIRED_D_COUNT_BY_NAME: { [name: string]: number } = {
  // Example: If Rios needs exactly 9 'D' shifts:
  // Rios: 9,
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
    if (!employee) return;

    const startDate = parseISO(absence.startDate);
    const endDate = parseISO(absence.endDate);

    schedule.days.forEach(day => {
      const currentDate = parseISO(day.date);
      if (currentDate >= startDate && currentDate <= endDate) {
        // Do not overwrite if already set (e.g., another absence overlapping?)
        if (day.shifts[absence.employeeId] === null) {
             day.shifts[absence.employeeId] = absence.type;
        }
      }
    });
  });
}

function applyFixedAssignments(schedule: Schedule, employees: Employee[]) {
    employees.forEach(employee => {
        // Preferences might be undefined if not set in UI, default to empty object
        const prefs = employee.preferences || {};

        if (prefs.fixedAssignments) {
            prefs.fixedAssignments.forEach(assignment => {
                 if (!assignment.date || !assignment.shift) return; // Skip incomplete fixed assignments
                const dayIndex = schedule.days.findIndex(d => d.date === assignment.date);
                if (dayIndex !== -1 && schedule.days[dayIndex].shifts[employee.id] === null) { // Only assign if not already assigned (e.g., LAO/LM)
                   schedule.days[dayIndex].shifts[employee.id] = assignment.shift;
                }
            });
        }
         if (prefs.fixedDaysOff) {
            prefs.fixedDaysOff.forEach(dateOff => {
                 if (!dateOff) return; // Skip empty fixed days off
                const dayIndex = schedule.days.findIndex(d => d.date === dateOff);
                 if (dayIndex !== -1 && schedule.days[dayIndex].shifts[employee.id] === null) {
                   schedule.days[dayIndex].shifts[employee.id] = 'D';
                 }
            })
         }
         if (prefs.fixedWorkShift) {
            const { dayOfWeek: daysOfWeek, shift } = prefs.fixedWorkShift;
            // Ensure daysOfWeek is an array before proceeding
            if(Array.isArray(daysOfWeek) && shift) {
                schedule.days.forEach(day => {
                    const currentDate = parseISO(day.date);
                    const currentDayOfWeek = getDay(currentDate); // Sunday = 0, Saturday = 6
                    if (daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday && day.shifts[employee.id] === null) {
                        day.shifts[employee.id] = shift;
                    }
                    // Prevent assigning M/T on non-fixed work days for this employee (if not holiday)
                     if (!daysOfWeek.includes(currentDayOfWeek) && (day.shifts[employee.id] === 'M' || day.shifts[employee.id] === 'T') && !day.isHoliday) {
                         // This case should ideally be handled by canWorkShift, but as a safety check:
                         // Revert the assignment if it conflicts? Or just let validation catch it?
                         // console.warn(`Conflict: ${employee.name} assigned ${day.shifts[employee.id]} on non-fixed work day ${day.date}`);
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
    let currentDate = subDays(parseISO(dateStr), 1); // Start checking from the day before

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
         if(format(currentDate, 'yyyy-MM-dd') !== histDateStr) {
             // If the history date doesn't match the expected previous day, the streak is broken by a gap
              return consecutiveDays;
         };
        const shift = history[histDateStr];
         if (shift === 'M' || shift === 'T') {
            consecutiveDays++;
            currentDate = subDays(currentDate, 1); // Move to the next day to check in history
        } else {
            // Streak broken in history
            return consecutiveDays;
        }
    }

    return consecutiveDays;
}


function canWorkShift(employee: Employee, dateStr: string, shift: ShiftType, schedule: Schedule, employees: Employee[]): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    if (!day || day.shifts[employee.id] !== null) return false; // Already assigned or day not found

    // Prio 5: Max Consecutive Days
    // Check if *adding* this work shift would exceed the limit
    if ((shift === 'M' || shift === 'T')) {
        const consecutiveBefore = getConsecutiveWorkDaysBefore(employee.id, dateStr, schedule, employees);
        if (consecutiveBefore >= MAX_CONSECUTIVE_WORK_DAYS) {
             // console.log(`Consecutive day violation for ${employee.name} on ${dateStr} (would be ${consecutiveBefore + 1})`);
             return false;
        }
    }

    // Prio 1/Flexible: Check fixed assignments/days off from preferences
    const prefs = employee.preferences || {};
    if (prefs.fixedAssignments?.some(a => a.date === dateStr && a.shift !== shift)) {
         return false; // Fixed assignment exists for this day with a *different* shift
     }
     if (prefs.fixedDaysOff?.includes(dateStr) && shift !== 'D') {
          return false; // If it's a fixed day off, ONLY 'D' is allowed (which shouldn't be passed here anyway)
      }
      // Fixed Work Shift (e.g., Alamo)
       if(prefs.fixedWorkShift){
         const { dayOfWeek: daysOfWeek, shift: fixedShift } = prefs.fixedWorkShift;
         if(Array.isArray(daysOfWeek) && fixedShift) {
             const currentDayOfWeek = getDay(parseISO(dateStr));
             const requiresFixedShift = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

             if(requiresFixedShift && shift !== fixedShift){
                 // Trying to assign something other than the required fixed shift
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
            // return false; // Make this strict if T->M is absolutely forbidden
        }
    }

    // Flexible Preferences (e.g., Forni) - Lower priority checks
      if (employee.name === 'Forni') { // Example using name, could use ID or a flag
           const currentDayOfWeek = getDay(parseISO(dateStr));
           if (prefs.preferWeekendWork && (shift === 'D' || shift === 'C' || shift === 'F') && day.isWeekend) return false; // Avoid non-work on preferred work weekend
           if (prefs.preferMondayRest && (shift === 'M' || shift === 'T') && currentDayOfWeek === 1 && !day.isHoliday) return false; // Avoid work on preferred rest Monday
           if (prefs.preferThursdayT && shift === 'M' && currentDayOfWeek === 4 && !day.isHoliday) return false; // Avoid M on preferred T Thursday
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
  if (day && day.shifts[employeeId] === null) { // Ensure we only assign to empty slots
    day.shifts[employeeId] = shift;

    // Update totals immediately
    if (shift === 'M') day.totals.M++;
    else if (shift === 'T') day.totals.T++;
    else if (shift === 'D') day.totals.D++;
    else if (shift === 'C') day.totals.C++;
    else if (shift === 'F') day.totals.F++;
    else if (shift === 'LM') day.totals.LM++;
    else if (shift === 'LAO') day.totals.LAO++;

    if (shift === 'M' || shift === 'T') day.totals.TPT++;

    // No need to update consecutiveWorkDays here, getConsecutiveWorkDaysBefore calculates on demand
  } else if(day && day.shifts[employeeId] !== null) {
      // console.warn(`Attempted to overwrite shift for employee ${employeeId} on ${dateStr}. Original: ${day.shifts[employeeId]}, New: ${shift}`);
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
    const currentDate = parseISO(day.date);
    const dayOfWeek = getDay(currentDate); // 0 = Sunday, 6 = Saturday

    Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
        const empId = parseInt(empIdStr);
        const empTotals = schedule.employeeTotals[empId];
        if (!empTotals) return; // Should not happen if initialized correctly

        if (shift === 'M') { day.totals.M++; empTotals.M++; empTotals.workedDays++; }
        else if (shift === 'T') { day.totals.T++; empTotals.T++; empTotals.workedDays++; }
        else if (shift === 'D') { day.totals.D++; empTotals.D++; }
        else if (shift === 'C') { day.totals.C++; empTotals.C++; }
        else if (shift === 'F') { day.totals.F++; empTotals.F++; }
        else if (shift === 'LM') { day.totals.LM++; empTotals.LM++; }
        else if (shift === 'LAO') { day.totals.LAO++; empTotals.LAO++; }

         // Check free weekends based on final assignment
         if (dayOfWeek === 6 && shift !== 'M' && shift !== 'T') empTotals.freeSaturdays++;
         if (dayOfWeek === 0 && shift !== 'M' && shift !== 'T') empTotals.freeSundays++;

    });
     day.totals.TPT = day.totals.M + day.totals.T;
  });

   // Verification log for employee total days
    employees.forEach(emp => {
         const totals = schedule.employeeTotals[emp.id];
         const totalAssigned = totals.workedDays + totals.C + totals.D + totals.F + totals.LM + totals.LAO;
         if(totalAssigned !== numDaysInMonth){
            console.error(`ALERT: Employee ${emp.name} (${emp.id}) total days mismatch. Assigned: ${totalAssigned}, Month Days: ${numDaysInMonth}`);
            // console.log("Employee Totals:", totals)
             // Log shifts for this employee
            // const empShifts = schedule.days.map(d => `${d.date}: ${d.shifts[emp.id] ?? '-'}`).join(', ');
            // console.log(`Shifts for ${emp.name}: ${empShifts}`)
         }
    });
}


function validateSchedule(schedule: Schedule, employees: Employee[], holidays: Holiday[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const employeeMap = new Map(employees.map(e => [e.id, e]));

  // --- Priority Rules ---

  // Prio 1: Absences & Fixed Assignments (Implicitly checked by application)
  // Add explicit checks here if needed to verify they weren't overwritten.

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
       if (employee) {
           const actualDs = schedule.employeeTotals[employee.id]?.D ?? 0;
           const passed = actualDs === requiredDs;
            if(!passed){
               results.push({
                   rule: `Priority 3 - Exact D Count (${name})`,
                   passed: false,
                   details: `Failed: Has ${actualDs}, requires ${requiredDs}`,
               });
            }
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
      const date1 = parseISO(day1.date);
      const date2 = parseISO(day2.date);

      // Check if it's a Saturday and Sunday pair
      if (getDay(date1) === 6 && getDay(date2) === 0) {
        if (day1.shifts[emp.id] === 'D' && day2.shifts[emp.id] === 'D') {
          ddWeekends++;
        }
      }
    }
     const passed = ddWeekends >= REQUIRED_DD_WEEKENDS;
     if (!passed) {
         results.push({
           rule: `Priority 4 - D/D Weekend (${emp.name})`,
           passed: false,
           details: `Failed: Has ${ddWeekends}, requires ${REQUIRED_DD_WEEKENDS}`,
         });
         anyPrio4Fail = true;
     }
  });
    if (!anyPrio4Fail) {
       results.push({ rule: `Priority 4 - D/D Weekend (Overall)`, passed: true, details: 'Passed'});
   }

   // Prio 5: Max Consecutive Days
   let maxConsecutiveOverall = 0;
   let maxConsecutiveEmployee = '';
   let prio5PassedOverall = true;

   employees.forEach(emp => {
       let currentConsecutive = 0;
       let maxForEmployee = 0;

        // Calculate consecutive days ending *before* the current schedule starts
       const initialConsecutive = getConsecutiveWorkDaysBefore(emp.id, schedule.days[0].date, schedule, employees);
       currentConsecutive = initialConsecutive;
       maxForEmployee = initialConsecutive;

       schedule.days.forEach(day => {
           const shift = day.shifts[emp.id];
           if (shift === 'M' || shift === 'T') {
               currentConsecutive++;
           } else {
               maxForEmployee = Math.max(maxForEmployee, currentConsecutive);
               currentConsecutive = 0; // Reset counter on non-work day
           }
       });
        maxForEmployee = Math.max(maxForEmployee, currentConsecutive); // Check at the end of the month

         if(maxForEmployee > maxConsecutiveOverall){
             maxConsecutiveOverall = maxForEmployee;
             maxConsecutiveEmployee = emp.name;
         }

         if (maxForEmployee > MAX_CONSECUTIVE_WORK_DAYS) {
             results.push({
                 rule: `Priority 5 - Max Consecutive Days (${emp.name})`,
                 passed: false,
                 details: `Failed: Worked ${maxForEmployee} consecutive days (Max ${MAX_CONSECUTIVE_WORK_DAYS})`,
             });
             prio5PassedOverall = false;
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
             const currentShift = schedule.days[i].shifts[emp.id];
             if (currentShift === 'M') {
                  const prevDate = subDays(parseISO(schedule.days[i].date), 1);
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
                    t_m_details.push(`${emp.name} on ${format(parseISO(schedule.days[i].date), 'dd/MM')}`);
                 }
             }
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
             results.push({
                 rule: `Flexible 4 - Target Staffing (${format(parseISO(day.date), 'dd/MM')})`,
                 passed: true, // Flexible - report deviation, not failure
                 details: `Deviation: Actual M=${M}, T=${T} (Target M=${targetM}, T=${targetT})`,
             });
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
                 results.push({
                     rule: `Flexible 5 - M/T Balance (${emp.name})`,
                     passed: true, // Flexible rule
                     details: `Potential Imbalance: M=${M}, T=${T} (Difference: ${diff})`,
                 });
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
        if (emp.name === 'Forni') { // Example check
            const prefs = emp.preferences || {};
            let violations: string[] = [];
            schedule.days.forEach(day => {
                 const shift = day.shifts[emp.id];
                 const date = parseISO(day.date);
                 const dayOfWeek = getDay(date);

                 if (prefs.preferWeekendWork && (shift === 'D' || shift === 'C' || shift === 'F') && day.isWeekend) violations.push(`Franco on preferred work weekend ${format(date, 'dd/MM')}`);
                 if (prefs.preferMondayRest && (shift === 'M' || shift === 'T') && dayOfWeek === 1 && !day.isHoliday) violations.push(`Worked on preferred rest Monday ${format(date, 'dd/MM')}`);
                 if (prefs.preferThursdayT && shift === 'M' && dayOfWeek === 4 && !day.isHoliday) violations.push(`Worked M on preferred T Thursday ${format(date, 'dd/MM')}`);
            })
             if (violations.length > 0) {
                results.push({
                    rule: `Flexible Preference - Forni`,
                    passed: true, // Flexible
                    details: `Preference Mismatches: ${violations.slice(0,2).join(', ')}${violations.length > 2 ? '...' : ''}`
                });
            }
        }
        // Add checks for other specific employee preferences here
    });

    // Ensure results are sorted by priority (approximate) then alphabetically
    results.sort((a, b) => {
         const getPrio = (rule: string): number => {
             if (rule.includes("Priority 1")) return 1;
             if (rule.includes("Priority 2")) return 2;
             if (rule.includes("Priority 3")) return 3;
             if (rule.includes("Priority 4")) return 4;
             if (rule.includes("Priority 5")) return 5;
             if (rule.includes("Flexible")) return 6;
             return 7; // Other/Error rules
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
    // 1. Assign essential shifts first (M and T for coverage)
    schedule.days.forEach(day => {
        let currentM = Object.values(day.shifts).filter(s => s === 'M').length;
        let currentT = Object.values(day.shifts).filter(s => s === 'T').length;
        let availableEmployees = employees.filter(e => day.shifts[e.id] === null);

        // --- Assign Minimum M ---
        while(currentM < MIN_COVERAGE_M) {
            const candidates = availableEmployees
                .filter(e => canWorkShift(e, day.date, 'M', schedule, employees))
                 // Simple sort: prioritize those with fewer M shifts so far? (Requires running totals)
                .sort((a, b) => (schedule.employeeTotals[a.id]?.M ?? 0) - (schedule.employeeTotals[b.id]?.M ?? 0));
            if (candidates.length === 0) break; // Cannot meet requirement
            assignShift(candidates[0].id, day.date, 'M', schedule);
            currentM++;
            availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id); // Remove assigned employee
        }

         // --- Assign Minimum T ---
        while(currentT < MIN_COVERAGE_T) {
            const candidates = availableEmployees
                .filter(e => canWorkShift(e, day.date, 'T', schedule, employees))
                .sort((a, b) => (schedule.employeeTotals[a.id]?.T ?? 0) - (schedule.employeeTotals[b.id]?.T ?? 0));
            if (candidates.length === 0) break;
            assignShift(candidates[0].id, day.date, 'T', schedule);
            currentT++;
            availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
        }

         // --- Ensure TPT >= 2 ---
         while (currentM + currentT < MIN_COVERAGE_TPT) {
             // Try M first
             let candidates = availableEmployees
                 .filter(e => canWorkShift(e, day.date, 'M', schedule, employees))
                 .sort((a, b) => (schedule.employeeTotals[a.id]?.M ?? 0) - (schedule.employeeTotals[b.id]?.M ?? 0));
             if (candidates.length > 0) {
                 assignShift(candidates[0].id, day.date, 'M', schedule);
                 currentM++;
                 availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
                 continue;
             }
              // Try T if M not possible
             candidates = availableEmployees
                 .filter(e => canWorkShift(e, day.date, 'T', schedule, employees))
                 .sort((a, b) => (schedule.employeeTotals[a.id]?.T ?? 0) - (schedule.employeeTotals[b.id]?.T ?? 0));
             if (candidates.length > 0) {
                 assignShift(candidates[0].id, day.date, 'T', schedule);
                 currentT++;
                 availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
                 continue;
             }
             break; // Cannot meet TPT requirement
         }

         // --- Enforce M > T rule (if applicable) ---
         if (!day.isHoliday && !day.isWeekend && (currentM + currentT) > MIN_COVERAGE_TPT && currentM <= currentT) {
             // Try assigning another M if possible
             const candidates = availableEmployees
                 .filter(e => canWorkShift(e, day.date, 'M', schedule, employees))
                 .sort((a, b) => (schedule.employeeTotals[a.id]?.M ?? 0) - (schedule.employeeTotals[b.id]?.M ?? 0));
             if (candidates.length > 0) {
                  assignShift(candidates[0].id, day.date, 'M', schedule);
                  currentM++;
                  availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
             } else {
                  // console.warn(`Could not enforce M>T rule for ${day.date}`);
             }
         }
    });

     // 2. Assign remaining shifts (D, F, C) - This needs more intelligence
     schedule.days.forEach(day => {
          employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                // Basic logic: F on holiday, D otherwise. Needs improvement for Prio 3/4.
                 if (day.isHoliday) {
                      // Should also check if employee *can* have F (not violating other rules?)
                      if(canWorkShift(emp, day.date, 'F', schedule, employees)){ // Basic check
                         assignShift(emp.id, day.date, 'F', schedule);
                      } else {
                          // What to do if F is not possible? Maybe assign D if allowed?
                          if(canWorkShift(emp, day.date, 'D', schedule, employees)){
                               assignShift(emp.id, day.date, 'D', schedule);
                          } else {
                               // console.warn(`Cannot assign F or D to ${emp.name} on holiday ${day.date}`);
                          }
                      }
                 } else {
                      // Prioritize D if possible and potentially needed (needs better logic)
                      if (canWorkShift(emp, day.date, 'D', schedule, employees)) {
                         assignShift(emp.id, day.date, 'D', schedule);
                      } else {
                          // Try C? Or leave unassigned for validation?
                           if (canWorkShift(emp, day.date, 'C', schedule, employees)) { // Assuming 'C' is a valid fallback
                                assignShift(emp.id, day.date, 'C', schedule);
                           } else {
                                // console.warn(`Cannot assign D or C to ${emp.name} on ${day.date}`);
                               // Leave as null, validation will catch unassigned days
                           }
                      }
                 }
            }
        });
     });
}


// --- Main Exported Function ---

export function generateSchedule(
  year: number,
  month: number,
  initialEmployees: Employee[],
  absences: Absence[],
  holidays: Holiday[]
): { schedule: Schedule; report: ValidationResult[] } {

  // Deep clone initial employees to avoid modifying the original array reference
  const employeesForGeneration: Employee[] = JSON.parse(JSON.stringify(initialEmployees));
  // Reset/Initialize state for this run
  currentEmployeesState = employeesForGeneration;

  // 0. Initialize Schedule Structure
  const startTime = performance.now();
  const schedule = initializeSchedule(year, month, employeesForGeneration, holidays);

  // 1. Apply Non-Negotiable Constraints First
  applyAbsences(schedule, absences, employeesForGeneration);
  applyFixedAssignments(schedule, employeesForGeneration); // Handles fixed shifts, days off

  // 2. Core Assignment Logic
  // Replace simple iterative fill with a more robust algorithm like backtracking or constraint solver if needed
  iterativeAssignShifts(schedule, employeesForGeneration);
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
  calculateFinalTotals(schedule, employeesForGeneration);

  // 4. Validate Final Schedule against all rules
  const report = validateSchedule(schedule, employeesForGeneration, holidays);
  const endTime = performance.now();
  console.log(`Schedule generation took ${(endTime - startTime).toFixed(2)} ms`);

   // Add generation time to report (optional)
   // report.push({ rule: "Generation Info", passed: true, details: `Generation took ${(endTime - startTime).toFixed(2)} ms` });

  return { schedule, report };
}

