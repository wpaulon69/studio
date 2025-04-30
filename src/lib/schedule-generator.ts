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
import { differenceInDays, format, parseISO, addDays, getDay, isWeekend, startOfMonth, endOfMonth, getDate } from 'date-fns';

// --- Constants and Configuration ---
const REQUIRED_REST_HOURS = 12;
const MAX_CONSECUTIVE_WORK_DAYS = 6;
const REQUIRED_DD_WEEKENDS = 1; // Minimum D/D weekends per eligible employee
const REQUIRED_D_COUNT: { [name: string]: number } = {
  Rios: 9,
  Cardozo: 9,
  Molina: 9,
  Montu: 9,
  Forni: 9,
};

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
        day.shifts[absence.employeeId] = absence.type;
      }
    });
  });
}

function applyFixedAssignments(schedule: Schedule, employees: Employee[]) {
    employees.forEach(employee => {
        if (employee.preferences?.fixedAssignments) {
            employee.preferences.fixedAssignments.forEach(assignment => {
                const dayIndex = schedule.days.findIndex(d => d.date === assignment.date);
                if (dayIndex !== -1 && schedule.days[dayIndex].shifts[employee.id] === null) { // Only assign if not already assigned (e.g., LAO/LM)
                   schedule.days[dayIndex].shifts[employee.id] = assignment.shift;
                }
            });
        }
         if (employee.preferences?.fixedDaysOff) {
            employee.preferences.fixedDaysOff.forEach(dateOff => {
                const dayIndex = schedule.days.findIndex(d => d.date === dateOff);
                 if (dayIndex !== -1 && schedule.days[dayIndex].shifts[employee.id] === null) {
                   schedule.days[dayIndex].shifts[employee.id] = 'D';
                 }
            })
         }
         if (employee.preferences?.fixedWorkShift) {
            const {dayOfWeek: daysOfWeek, shift} = employee.preferences.fixedWorkShift
            schedule.days.forEach(day => {
                 const currentDate = parseISO(day.date);
                 const currentDayOfWeek = getDay(currentDate); // Sunday = 0, Saturday = 6
                  if (daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday && day.shifts[employee.id] === null) {
                    day.shifts[employee.id] = shift;
                  }
            })
         }
    });
}


function getConsecutiveWorkDays(employeeId: number, dateStr: string, schedule: Schedule, history: Employee['history']): number {
    let consecutiveDays = 0;
    let currentDate = parseISO(dateStr);
    const scheduleStartIndex = schedule.days.findIndex(d => d.date === format(startOfMonth(currentDate), 'yyyy-MM-dd'));

    // Check current schedule backwards
    for (let i = schedule.days.findIndex(d => d.date === dateStr) -1; i >= scheduleStartIndex; i--) {
        const shift = schedule.days[i].shifts[employeeId];
        if (shift === 'M' || shift === 'T') {
            consecutiveDays++;
        } else if (shift !== null) { // Any non-work shift breaks the streak
            return consecutiveDays;
        } else {
            // If null, we can't determine the streak yet, assume it continues for now for safety in assignment checks
            // Or, ideally, this function is called after preliminary assignments
            return consecutiveDays; // Or maybe throw error if called too early?
        }
    }

    // Check history if we reached the beginning of the month schedule
    const historyDates = Object.keys(history).sort().reverse(); // Sort recent first
    let historyDate = addDays(startOfMonth(currentDate), -1);
    for(const histDateStr of historyDates){
         if(format(historyDate, 'yyyy-MM-dd') !== histDateStr) continue; // Ensure we are checking contiguous days
        const shift = history[histDateStr];
         if (shift === 'M' || shift === 'T') {
            consecutiveDays++;
            historyDate = addDays(historyDate, -1);
        } else {
            break; // Streak broken in history
        }
    }


    return consecutiveDays;
}


function calculateInitialConsecutiveDays(employees: Employee[]): void {
  employees.forEach(emp => {
    let consecutiveDays = 0;
    const historyDates = Object.keys(emp.history).sort().reverse(); // Sort recent first
    let expectedDate = addDays(parseISO('2025-05-01'), -1); // Start checking from April 30th backwards

    for (const dateStr of historyDates) {
        const currentDate = parseISO(dateStr);
         // Ensure we're looking at contiguous days backwards from start of May
        if (format(currentDate, 'yyyy-MM-dd') !== format(expectedDate, 'yyyy-MM-dd')) {
             // If there's a gap or dates are not in sequence, stop counting
             // console.log(`Gap detected for ${emp.name}: Expected ${format(expectedDate, 'yyyy-MM-dd')}, got ${dateStr}`)
             break;
         }

        const shift = emp.history[dateStr];
        if (shift === 'M' || shift === 'T') {
            consecutiveDays++;
            expectedDate = addDays(expectedDate, -1); // Move to the previous day
        } else {
            break; // Streak broken
        }
    }
    emp.consecutiveWorkDays = consecutiveDays;
     // console.log(`Initial consecutive days for ${emp.name}: ${emp.consecutiveWorkDays}`);
  });
}


function canWorkShift(employee: Employee, dateStr: string, shift: ShiftType, schedule: Schedule): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    if (!day || day.shifts[employee.id] !== null) return false; // Already assigned or day not found

    // Prio 5: Max Consecutive Days
    const consecutive = getConsecutiveWorkDays(employee.id, dateStr, schedule, employee.history);
    if ((shift === 'M' || shift === 'T') && consecutive >= MAX_CONSECUTIVE_WORK_DAYS) {
      // console.log(`Consecutive day violation for ${employee.name} on ${dateStr} (${consecutive})`);
      return false;
    }


    // Flexible 1: T -> M Rest (Attempt) - This is tricky to enforce strictly during initial assignment
    // We might need a post-processing step or check it when confirming assignments.
    // For now, let's check the immediate previous day if assigning 'M'.
    if (shift === 'M') {
        const prevDate = addDays(parseISO(dateStr), -1);
        const prevDateStr = format(prevDate, 'yyyy-MM-dd');
        const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
        let prevShift: ShiftType | null = null;

        if (prevDaySchedule) {
            prevShift = prevDaySchedule.shifts[employee.id];
        } else {
            // Check history if it's the first day of the month
            if (getDate(parseISO(dateStr)) === 1) {
                 const lastDayOfPrevMonthStr = format(addDays(parseISO(dateStr), -1), 'yyyy-MM-dd');
                 prevShift = employee.history[lastDayOfPrevMonthStr] || null;
            }
        }

        if (prevShift === 'T') {
            // console.log(`Potential T->M violation for ${employee.name} on ${dateStr}`);
            // return false; // If we make this strict here, might fail schedule generation
            // Let's allow it for now and flag it in validation.
        }
    }

     // Check fixed preferences (redundant if applyFixedAssignments is run first, but good safety check)
    if (employee.preferences?.fixedAssignments?.some(a => a.date === dateStr && a.shift !== shift)) {
         return false; // Fixed assignment exists for this day with a *different* shift
     }
      if (employee.preferences?.fixedDaysOff?.includes(dateStr)) {
          return shift === 'D'; // Can only be 'D' if it's a fixed day off
      }
       if(employee.preferences?.fixedWorkShift){
         const {dayOfWeek: daysOfWeek, shift: fixedShift} = employee.preferences.fixedWorkShift;
         const currentDayOfWeek = getDay(parseISO(dateStr));
          if(daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday && shift !== fixedShift){
              // If it's a required work day/shift for Alamo, don't assign something else
              return false;
          }
          // If it's NOT a required work day for Alamo, he shouldn't be assigned M or T
          if(!daysOfWeek.includes(currentDayOfWeek) && (shift === 'M' || shift === 'T') && !day.isHoliday){
               return false;
          }
       }

      // Forni Preferences: Prefers weekends, rests Mondays, Thursday T
      if (employee.name === 'Forni') {
           if (shift === 'D' && day.isWeekend) return false; // Prefer not to rest on weekend
           if ((shift === 'M' || shift === 'T') && getDay(parseISO(dateStr)) === 1) return false; // Prefer to rest Monday
           if (getDay(parseISO(dateStr)) === 4 && shift === 'M') return false; // Prefer Thursday T
      }


    return true;
}

function assignShift(employee: Employee, dateStr: string, shift: ShiftType, schedule: Schedule) {
  const day = schedule.days.find(d => d.date === dateStr);
  if (day) {
    day.shifts[employee.id] = shift;
    // Update consecutive days count immediately *after* assignment
     if (shift === 'M' || shift === 'T') {
         // Find employee in the main array to update the object reference
        const empIndex = employees.findIndex(e => e.id === employee.id);
        if(empIndex > -1){
            employees[empIndex].consecutiveWorkDays = (employee.consecutiveWorkDays || 0) + 1;
        }
      } else {
         const empIndex = employees.findIndex(e => e.id === employee.id);
         if(empIndex > -1){
             employees[empIndex].consecutiveWorkDays = 0;
         }
      }
  }
}


function calculateDailyTotals(schedule: Schedule) {
  schedule.days.forEach(day => {
    let M = 0, T = 0, D = 0, C = 0, F = 0, LM = 0, LAO = 0;
    Object.values(day.shifts).forEach(shift => {
      if (shift === 'M') M++;
      else if (shift === 'T') T++;
      else if (shift === 'D') D++;
      else if (shift === 'C') C++;
      else if (shift === 'F') F++;
      else if (shift === 'LM') LM++;
      else if (shift === 'LAO') LAO++;
    });
    day.totals = { M, T, D, C, F, LM, LAO, TPT: M + T };
  });
}

function calculateEmployeeTotals(schedule: Schedule, employees: Employee[]) {
   const numDaysInMonth = schedule.days.length;
    employees.forEach(emp => {
        let workedDays = 0, M = 0, T = 0, freeSaturdays = 0, freeSundays = 0, F = 0, C = 0, D = 0, LM = 0, LAO = 0;
        let currentWeekSaturdayFree = false;
        let currentWeekSundayFree = false;

        schedule.days.forEach(day => {
            const shift = day.shifts[emp.id];
            const currentDate = parseISO(day.date);
            const dayOfWeek = getDay(currentDate); // 0 = Sunday, 6 = Saturday

            if (shift === 'M') { M++; workedDays++; }
            else if (shift === 'T') { T++; workedDays++; }
            else if (shift === 'D') D++;
            else if (shift === 'C') C++;
            else if (shift === 'F') F++;
            else if (shift === 'LM') LM++;
            else if (shift === 'LAO') LAO++;

             // Check free weekends
            if (dayOfWeek === 6) { // Saturday
                if (shift !== 'M' && shift !== 'T') {
                     currentWeekSaturdayFree = true;
                } else {
                    currentWeekSaturdayFree = false;
                }
            } else if (dayOfWeek === 0) { // Sunday
                 if (shift !== 'M' && shift !== 'T') {
                     currentWeekSundayFree = true;
                } else {
                    currentWeekSundayFree = false;
                }
                 // Check at the end of Sunday if the full weekend was free
                 if(currentWeekSaturdayFree && currentWeekSundayFree){
                     // This logic isn't quite right for counting *total* free Saturdays/Sundays. Recalculate:
                 }
            }

            // Reset flags at the start of a new week (Monday)
            // if (dayOfWeek === 1) {
            //     currentWeekSaturdayFree = false;
            //     currentWeekSundayFree = false;
            // }
        });

         // Recalculate free Saturdays/Sundays correctly
         schedule.days.forEach(day => {
             const shift = day.shifts[emp.id];
             const currentDate = parseISO(day.date);
             const dayOfWeek = getDay(currentDate);
             if(dayOfWeek === 6 && shift !== 'M' && shift !== 'T') freeSaturdays++;
             if(dayOfWeek === 0 && shift !== 'M' && shift !== 'T') freeSundays++;
         })

        schedule.employeeTotals[emp.id] = { workedDays, M, T, freeSaturdays, freeSundays, F, C, D, LM, LAO };

         // Verification log
         const totalAssigned = workedDays + C + D + F + LM + LAO;
         if(totalAssigned !== numDaysInMonth){
            console.error(`ALERT: Employee ${emp.name} total days mismatch. Assigned: ${totalAssigned}, Month Days: ${numDaysInMonth}`);
         }

    });
}

function validateSchedule(schedule: Schedule, employees: Employee[], holidays: Holiday[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const employeeMap = new Map(employees.map(e => [e.id, e]));

  // Prio 1: Absences (Implicitly checked by pre-assignment)
  // We assume applyAbsences worked correctly. Maybe add a check here to ensure those days *are* LAO/LM.

  // Prio 2: Coverage & M/T Ratio
  schedule.days.forEach(day => {
    const { M, T, TPT } = day.totals;
    let rule2Passed = true;
    let details = [];

    if (TPT < 2) {
      rule2Passed = false;
      details.push(`TPT=${TPT} (Requires >=2)`);
    }
    if (M < 1) {
      rule2Passed = false;
      details.push(`M=${M} (Requires >=1)`);
    }
    if (T < 1) {
      rule2Passed = false;
      details.push(`T=${T} (Requires >=1)`);
    }
    if (TPT > 2 && !day.isHoliday && !day.isWeekend && M <= T) {
        rule2Passed = false;
        details.push(`M=${M}, T=${T} on non-holiday weekday (Requires M>T when TPT>2)`);
    }

    results.push({
      rule: `Priority 2 - Coverage/Ratio (${day.date})`,
      passed: rule2Passed,
      details: rule2Passed ? 'Passed' : details.join(', '),
    });
  });

  // Prio 3: Exact Descansos (D)
   Object.entries(REQUIRED_D_COUNT).forEach(([name, requiredDs]) => {
       const employee = employees.find(e => e.name === name);
       if (employee) {
           const actualDs = schedule.employeeTotals[employee.id]?.D ?? 0;
           const passed = actualDs === requiredDs;
           results.push({
               rule: `Priority 3 - Exact D (${name})`,
               passed: passed,
               details: passed ? `Passed (${actualDs}/${requiredDs})` : `Failed: Has ${actualDs}, requires ${requiredDs}`,
           });
       }
   });
    // Check F doesn't count as D and D not on Holiday
    schedule.days.forEach(day => {
        if(day.isHoliday){
            Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
                 if(shift === 'D'){
                     const empId = parseInt(empIdStr);
                     const employee = employeeMap.get(empId);
                      results.push({
                         rule: `Priority 3 - D on Holiday`,
                         passed: false,
                         details: `Failed: ${employee?.name || `Emp ${empId}`} has D on holiday ${day.date}`,
                     });
                 }
            })
        }
    });


  // Prio 4: D/D Weekends
  employees.forEach(emp => {
    if (!emp.eligibleWeekend || emp.name === 'Alamo') return; // Only check eligible employees
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
     results.push({
       rule: `Priority 4 - D/D Weekend (${emp.name})`,
       passed: passed,
       details: passed ? `Passed (${ddWeekends}/${REQUIRED_DD_WEEKENDS})` : `Failed: Has ${ddWeekends}, requires ${REQUIRED_DD_WEEKENDS}`,
     });

  });

   // Prio 5: Max Consecutive Days
   let maxConsecutiveOverall = 0;
   let maxConsecutiveEmployee = '';
   employees.forEach(emp => {
       let currentConsecutive = 0;
       let maxForEmployee = 0;

       // Check history first
       let initialConsecutive = 0;
       const historyDates = Object.keys(emp.history).sort().reverse();
       let expectedDate = addDays(parseISO(schedule.days[0].date), -1);
       for (const dateStr of historyDates) {
           const currentDate = parseISO(dateStr);
           if (format(currentDate, 'yyyy-MM-dd') !== format(expectedDate, 'yyyy-MM-dd')) break;
           const shift = emp.history[dateStr];
           if(shift === 'M' || shift === 'T'){
               initialConsecutive++;
               expectedDate = addDays(expectedDate, -1);
           } else {
               break;
           }
       }
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
         }
   });
     // Add one overall result for Prio 5 for summary
   const prio5Passed = maxConsecutiveOverall <= MAX_CONSECUTIVE_WORK_DAYS;
    results.push({
        rule: `Priority 5 - Max Consecutive Days (Overall)`,
        passed: prio5Passed,
        details: prio5Passed ? `Passed (Max found: ${maxConsecutiveOverall})` : `Failed (Max found: ${maxConsecutiveOverall} by ${maxConsecutiveEmployee})`,
    });


  // Flexible Rules Validation (Optional, report potential issues)
    // Flex 1: T->M Rest
    let t_m_violations = 0;
     employees.forEach(emp => {
         for (let i = 1; i < schedule.days.length; i++) {
             const prevShift = schedule.days[i-1].shifts[emp.id];
             const currentShift = schedule.days[i].shifts[emp.id];
             if (prevShift === 'T' && currentShift === 'M') {
                t_m_violations++;
                 // console.log(`T->M Violation: ${emp.name} on ${schedule.days[i].date}`);
             }
         }
          // Check transition from April 30th to May 1st
          const lastDayOfPrevMonthStr = format(addDays(parseISO(schedule.days[0].date), -1), 'yyyy-MM-dd');
          const firstDayShift = schedule.days[0].shifts[emp.id];
          const lastDayHistoryShift = emp.history[lastDayOfPrevMonthStr];
          if (lastDayHistoryShift === 'T' && firstDayShift === 'M') {
             t_m_violations++;
              // console.log(`T->M Violation (Month boundary): ${emp.name} on ${schedule.days[0].date}`);
          }
     })
      results.push({
        rule: `Flexible 1 - T->M 12h Rest`,
        passed: t_m_violations === 0,
        details: t_m_violations === 0 ? 'Passed' : `Potential Violations: ${t_m_violations} instances detected`,
    });


  // --- Add more validations for other flexible rules if needed ---
    // Flex 3: Consecutive blocks (Hard to quantify 'passed')
    // Flex 4: Target Dotation (Check daily M/T against targets)
     schedule.days.forEach(day => {
        const { M, T } = day.totals;
        const isWorkDay = !day.isHoliday && !day.isWeekend;
        const targetM = isWorkDay ? 3 : 2;
        const targetT = 1; // Always 1

         if(M !== targetM || T !== targetT) {
             results.push({
                 rule: `Flexible 4 - Target Staffing (${day.date})`,
                 passed: false, // Consider this 'flexible', so always 'passed' might be better? Or just note deviation.
                 details: `Deviation: Actual M=${M}, T=${T}. Target M=${targetM}, T=${targetT}`,
             });
         }
     })


    // Flex 5: M/T Balance (Check employee M vs T totals)
     employees.forEach(emp => {
         if(emp.name === 'Alamo') return; // Alamo has fixed schedule
         const { M, T } = schedule.employeeTotals[emp.id] ?? { M: 0, T: 0 };
         const totalShifts = M + T;
         if (totalShifts > 0) {
             const diff = Math.abs(M - T);
             const percentageDiff = (diff / totalShifts) * 100;
             // Define a threshold for 'imbalance', e.g., > 20% difference
             if (percentageDiff > 25) { // Example threshold
                 results.push({
                     rule: `Flexible 5 - M/T Balance (${emp.name})`,
                     passed: false, // Flexible rule violation
                     details: `Imbalance: M=${M}, T=${T} (${percentageDiff.toFixed(1)}% difference)`,
                 });
             }
         }
     });


    // Flex 6 & 7: Forni/Cardozo/Molina specific preferences (check if met)
    // ...


  return results;
}

// --- Main Generation Logic ---

// Placeholder for the actual assignment algorithm.
// This needs to be a more sophisticated function, potentially recursive or iterative,
// trying different assignments while respecting priorities.
// This simple version just fills remaining spots somewhat randomly, NOT respecting rules fully.
function simpleFillRemainingShifts(schedule: Schedule, employees: Employee[]) {
    const assignableEmployees = employees.filter(e => e.name !== 'Alamo'); // Alamo is mostly fixed

    schedule.days.forEach(day => {
         // 1. Ensure minimum coverage (rudimentary)
         let currentM = Object.values(day.shifts).filter(s => s === 'M').length;
         let currentT = Object.values(day.shifts).filter(s => s === 'T').length;
         let currentTPT = currentM + currentT;

         // Try assigning M first if needed
         while (currentM < 1 || (currentTPT < 2 && currentM === 0)) {
             const availableEmps = assignableEmployees.filter(e => canWorkShift(e, day.date, 'M', schedule));
             if (availableEmps.length === 0) break; // Cannot assign
             const empToAssign = availableEmps[0]; // Simplistic choice
             assignShift(empToAssign, day.date, 'M', schedule);
             currentM++;
             currentTPT++;
         }

         // Try assigning T if needed
         while (currentT < 1 || (currentTPT < 2 && currentT === 0)) {
             const availableEmps = assignableEmployees.filter(e => canWorkShift(e, day.date, 'T', schedule));
              if (availableEmps.length === 0) break; // Cannot assign
             const empToAssign = availableEmps[0]; // Simplistic choice
             assignShift(empToAssign, day.date, 'T', schedule);
             currentT++;
             currentTPT++;
         }

          // Apply M > T rule (very simplified)
          if(!day.isHoliday && !day.isWeekend && currentTPT > 2 && currentM <= currentT){
                // Try to convert a T to M if possible
                const tEmployees = Object.entries(day.shifts)
                    .filter(([id, s]) => s === 'T' && employees.find(e => e.id === parseInt(id))?.name !== 'Alamo')
                    .map(([id, s]) => employees.find(e => e.id === parseInt(id))!);

                 for(const empT of tEmployees) {
                     // Check if this employee CAN work M instead without violating consecutive days etc.
                     // Need a 'canSwitch' function or temporarily revert, check canWorkShift('M'), then reapply
                     // This gets complex quickly. Let's skip the switch logic for this simple fill.
                     // console.log(`Potential M>T fix needed for ${day.date}, but simple filler skips switch.`);
                      break; // Only attempt one fix for simplicity
                 }
          }


        // 2. Fill remaining nulls with D or F
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                 if (day.isHoliday) {
                    // Check if already has enough D shifts? No, prio 3 is checked later.
                     // Cannot assign D on holiday according to rules interpretation.
                     // Can assign F only if not M/T/LI/LAO/C already assigned.
                     // Since it's null, we can assign F.
                     assignShift(emp, day.date, 'F', schedule);
                 } else {
                     // Assign D if not holiday
                     // Check against required D count? (More complex logic needed here)
                      const requiredDs = REQUIRED_D_COUNT[emp.name];
                      const currentDs = schedule.employeeTotals[emp.id]?.D ?? 0; // Need to calculate totals *during* assignment for this check

                     // Simple assignment: just put D
                     assignShift(emp, day.date, 'D', schedule);
                 }
            }
        });
    });
}


// --- Global Employee Data (needed because assignShift modifies it) ---
let employees: Employee[] = [];


export function generateSchedule(
  year: number,
  month: number,
  initialEmployees: Employee[],
  absences: Absence[],
  holidays: Holiday[]
): { schedule: Schedule; report: ValidationResult[] } {

  // Deep clone employees to avoid modifying the original input array reference across calls
  employees = JSON.parse(JSON.stringify(initialEmployees));

  // 0. Initialize
  const startTime = performance.now();
  calculateInitialConsecutiveDays(employees); // Calculate based on provided history
  const schedule = initializeSchedule(year, month, employees, holidays);

  // 1. Apply Priority 1: Absences (LAO, LM)
  applyAbsences(schedule, absences, employees);

  // 2. Apply Fixed Preferences (Part of Prio 1 / High Prio Flexible)
  // Includes Alamo's fixed schedule, Cardozo/Molina specific days/shifts
  applyFixedAssignments(schedule, employees);

  // 3. Core Assignment Logic (Needs Improvement - Placeholder)
  // This is where the backtracking/constraint satisfaction algorithm would go.
  // It needs to iterate through days/employees, try assigning shifts (M, T, D)
  // while constantly checking against Priorities 2, 3, 4, 5.
  // simpleFillRemainingShifts(schedule, employees); // Replace with sophisticated logic

  // --- Start of a more structured assignment approach ---

  // Assign Required 'D' shifts (Prio 3) & Weekends (Prio 4) - Needs careful logic
  // Assign minimum coverage shifts (M/T) respecting M>T (Prio 2) & consecutive days (Prio 5)
  // Assign remaining shifts (D/F/C) respecting rules


  // --- Placeholder: Simplified Fill ---
   schedule.days.forEach(day => {
       const availableEmployees = employees.filter(e => day.shifts[e.id] === null); // Employees not yet assigned LAO/LM/Fixed

        // Prioritize assigning shifts to meet Prio 2 (TPT>=2, M>=1, T>=1, M>T rule)
        let currentM = Object.values(day.shifts).filter(s => s === 'M').length;
        let currentT = Object.values(day.shifts).filter(s => s === 'T').length;
        let assignedInLoop = true;

        while (assignedInLoop){ // Loop until no more assignments can be made for coverage/ratio
            assignedInLoop = false;

            // Need M?
            if(currentM < 1){
                const candidates = availableEmployees.filter(e => canWorkShift(e, day.date, 'M', schedule));
                if(candidates.length > 0){
                     // TODO: Better candidate selection (e.g., least M shifts so far?)
                    assignShift(candidates[0], day.date, 'M', schedule);
                    currentM++;
                    assignedInLoop = true;
                    continue; // Re-evaluate conditions
                }
            }

             // Need T?
            if(currentT < 1){
                 const candidates = availableEmployees.filter(e => canWorkShift(e, day.date, 'T', schedule));
                 if(candidates.length > 0){
                    // TODO: Better candidate selection
                    assignShift(candidates[0], day.date, 'T', schedule);
                    currentT++;
                    assignedInLoop = true;
                    continue;
                 }
            }

             // Need TPT >= 2?
             if(currentM + currentT < 2){
                 // Try assigning M first if possible
                 let candidates = availableEmployees.filter(e => canWorkShift(e, day.date, 'M', schedule));
                 if(candidates.length > 0) {
                      assignShift(candidates[0], day.date, 'M', schedule);
                      currentM++;
                      assignedInLoop = true;
                      continue;
                 }
                  // Else try assigning T
                 candidates = availableEmployees.filter(e => canWorkShift(e, day.date, 'T', schedule));
                  if(candidates.length > 0) {
                      assignShift(candidates[0], day.date, 'T', schedule);
                      currentT++;
                      assignedInLoop = true;
                      continue;
                 }
             }

              // Check M > T rule on non-holiday weekdays
              if(currentM + currentT > 2 && M <= T && !day.isHoliday && !day.isWeekend){
                   // Try to assign another M if possible
                  let candidates = availableEmployees.filter(e => canWorkShift(e, day.date, 'M', schedule));
                  if(candidates.length > 0) {
                       assignShift(candidates[0], day.date, 'M', schedule);
                       currentM++;
                       assignedInLoop = true;
                       continue;
                  } else {
                      // Cannot enforce M>T by adding more M. Violation likely.
                      // console.warn(`Cannot enforce M>T for ${day.date} - No more M candidates.`);
                  }
              }
        }


       // Assign remaining nulls (D, F)
       employees.forEach(emp => {
           if (day.shifts[emp.id] === null) {
                // Prioritize assigning D if needed for Prio 3 & Prio 4, else F on holidays
                 const isEligibleForD = emp.name !== 'Alamo'; // Assuming Alamo doesn't get normal D
                 const needsD = REQUIRED_D_COUNT[emp.name] !== undefined && (schedule.employeeTotals[emp.id]?.D ?? 0) < REQUIRED_D_COUNT[emp.name];

                 if (day.isHoliday) {
                      assignShift(emp, day.date, 'F', schedule); // Assign F on holidays if free
                 } else if (isEligibleForD) { // Prioritize D for those who need them
                      // Basic D assignment - needs better logic for balancing and Prio 4
                      assignShift(emp, day.date, 'D', schedule);
                 } else {
                     // Fallback for employees like Alamo on non-workdays or if D is not needed
                     assignShift(emp, day.date, 'D'); // Default to D? Or should it be C? Depends on policy.
                 }
           }
       });

   });


  // 4. Calculate Totals
  calculateDailyTotals(schedule);
  calculateEmployeeTotals(schedule, employees); // Pass the *updated* employees array

  // 5. Validate Final Schedule
  const report = validateSchedule(schedule, employees, holidays); // Pass updated employees
  const endTime = performance.now();
  // console.log(`Schedule generation took ${(endTime - startTime).toFixed(2)} ms`);


  return { schedule, report };
}
