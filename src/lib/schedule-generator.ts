

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

// Target staffing levels (flexible)
const TARGET_M_WORKDAY = 3;
const TARGET_M_WEEKEND_HOLIDAY = 2;
const TARGET_T = 1;


// --- Helper Functions ---

function countWeekendDaysInMonth(year: number, month: number): number {
  const startDate = startOfMonth(new Date(year, month - 1));
  const endDate = endOfMonth(new Date(year, month - 1));
  let weekendDays = 0;
  let currentDate = startDate;
  while (currentDate <= endDate) {
    if (isWeekend(currentDate)) {
      weekendDays++;
    }
    currentDate = addDays(currentDate, 1);
  }
  return weekendDays;
}

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
                            console.warn(`Cannot assign fixed 'D' to ${employee.name} on holiday ${dateOff}. Assigning 'F' instead.`);
                            // Assign 'F' if 'D' is requested on a holiday
                            schedule.days[dayIndex].shifts[employee.id] = 'F';
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
                  return consecutiveDays;
              };
             const shift = history[histDateStr];
              if (shift === 'M' || shift === 'T') {
                 consecutiveDays++;
                 currentDate = subDays(currentDate, 1); // Move to the next day to check in history
             } else {
                 return consecutiveDays;
             }
         } catch (e) {
              console.warn(`Error parsing history date ${histDateStr} for employee ${employee.name}. Skipping.`);
              return consecutiveDays; // Stop checking history on error
         }
    }
    return consecutiveDays;
}


function canWorkShift(employee: Employee, dateStr: string, shift: ShiftType | null, schedule: Schedule, employees: Employee[]): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    if (!day) return false; // Day not found

    // Allow assignment if shift is null (clearing)
    if(shift === null) return true;

     // Cannot assign if already LAO or LM (highest priority), unless trying to assign the same LAO/LM again (idempotent)
     const existingShift = day.shifts[employee.id];
     if ((existingShift === 'LAO' || existingShift === 'LM') && existingShift !== shift) {
         return false;
     }


    // Prio 5: Max Consecutive Days
    if ((shift === 'M' || shift === 'T')) {
        const consecutiveBefore = getConsecutiveWorkDaysBefore(employee.id, dateStr, schedule, employees);
        if (consecutiveBefore >= MAX_CONSECUTIVE_WORK_DAYS) {
             return false;
        }
    }

    // Prio 3: Cannot assign 'D' on a holiday
    if (shift === 'D' && day.isHoliday) {
        return false;
    }


    const prefs = employee.preferences || {};
    if (prefs.fixedAssignments?.some(a => a.date === dateStr && a.shift !== shift)) {
         if(existingShift !== 'LAO' && existingShift !== 'LM'){
            return false; 
         }
     }
     if (prefs.fixedDaysOff?.includes(dateStr) && (shift === 'M' || shift === 'T')) {
           if(existingShift !== 'LAO' && existingShift !== 'LM'){
              return false; 
           }
      }
      if (prefs.fixedDaysOff?.includes(dateStr) && shift !== 'D') {
           if (!(shift === 'F' && day.isHoliday) && shift !== 'LAO' && shift !== 'LM') {
               return false;
           }
      }

       if(prefs.fixedWorkShift){
         const { dayOfWeek: daysOfWeek, shift: fixedShift } = prefs.fixedWorkShift;
         if(Array.isArray(daysOfWeek) && fixedShift) {
             const currentDayOfWeek = getDay(parseISO(dateStr));
             const requiresFixedShift = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

             if(requiresFixedShift && shift !== fixedShift){
                 if(existingShift !== 'LAO' && existingShift !== 'LM'){
                     return false;
                 }
             }
             if(!requiresFixedShift && (shift === 'M' || shift === 'T') && !day.isHoliday){
                 if(existingShift !== 'LAO' && existingShift !== 'LM'){
                      return false;
                 }
             }
         }
       }

    if (shift === 'M') {
        const prevDate = subDays(parseISO(dateStr), 1);
        const prevDateStr = format(prevDate, 'yyyy-MM-dd');
        const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
        let prevShift: ShiftType | null = null;

        if (prevDaySchedule) {
            prevShift = prevDaySchedule.shifts[employee.id];
        } else {
             prevShift = employee.history?.[prevDateStr] || null;
        }

        if (prevShift === 'T') {
            // Validation should handle reporting.
        }
    }
    return true;
}

// --- Global Employee Data (needed for stateful updates within generation scope) ---
let currentEmployeesState: Employee[] = [];

function assignShift(employeeId: number, dateStr: string, shift: ShiftType | null, schedule: Schedule) {
  const day = schedule.days.find(d => d.date === dateStr);
  if (!day) return;

  const currentShift = day.shifts[employeeId];

  if (currentShift === null || shift === null || (currentShift !== 'LAO' && currentShift !== 'LM')) {
      const employee = currentEmployeesState.find(e => e.id === employeeId);
      if (employee && canWorkShift(employee, dateStr, shift, schedule, currentEmployeesState)) {
           day.shifts[employeeId] = shift;
      } else {
           console.warn(`Generator prevented invalid assignment: ${shift} for Emp ${employeeId} on ${dateStr}. Current: ${currentShift}`);
      }
  } else if(currentShift === 'LAO' || currentShift === 'LM') {
       if(shift !== currentShift) { 
           console.warn(`Assignment blocked: Cannot overwrite ${currentShift} with ${shift} for employee ${employeeId} on ${dateStr}.`);
       }
  }
}


export function calculateFinalTotals(schedule: Schedule, employees: Employee[]) {
  schedule.days.forEach(day => {
    day.totals = { M: 0, T: 0, D: 0, C: 0, F: 0, LM: 0, LAO: 0, TPT: 0 };
  });
   employees.forEach(emp => {
        if (!schedule.employeeTotals[emp.id]) {
             schedule.employeeTotals[emp.id] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, C: 0, D: 0, LM: 0, LAO: 0 };
        } else {
             Object.keys(schedule.employeeTotals[emp.id]).forEach(key => {
                  (schedule.employeeTotals[emp.id] as any)[key] = 0;
             });
        }
   });


  const numDaysInMonth = schedule.days.length;

  schedule.days.forEach(day => {
    let date: Date;
    try {
        date = parseISO(day.date);
        if (!isValid(date)) throw new Error('Invalid date');
    } catch (e) {
        console.error(`Error parsing date for totals calculation: ${day.date}`);
        return; 
    }

    const dayOfWeek = getDay(date); 

    Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
        const empId = parseInt(empIdStr);
        const empTotals = schedule.employeeTotals[empId];
        if (!empTotals) {
            console.warn(`Employee totals not found for ID ${empId} during final calculation. Initializing.`);
            schedule.employeeTotals[empId] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, C: 0, D: 0, LM: 0, LAO: 0 }; 
        }
         const currentEmpTotals = schedule.employeeTotals[empId];


        if (shift === 'M') { day.totals.M++; currentEmpTotals.M++; currentEmpTotals.workedDays++; }
        else if (shift === 'T') { day.totals.T++; currentEmpTotals.T++; currentEmpTotals.workedDays++; }
        else if (shift === 'D') { day.totals.D++; currentEmpTotals.D++; }
        else if (shift === 'C') { day.totals.C++; currentEmpTotals.C++; }
        else if (shift === 'F') { day.totals.F++; currentEmpTotals.F++; }
        else if (shift === 'LM') { day.totals.LM++; currentEmpTotals.LM++; }
        else if (shift === 'LAO') { day.totals.LAO++; currentEmpTotals.LAO++; }

         if (dayOfWeek === 6 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSaturdays++;
         if (dayOfWeek === 0 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSundays++;

    });
     day.totals.TPT = day.totals.M + day.totals.T;
  });

    employees.forEach(emp => {
         const totals = schedule.employeeTotals[emp.id];
         if (!totals) {
             console.warn(`Totals missing for employee ${emp.name} (${emp.id}) during final verification.`);
             return;
         }
         const totalAssigned = totals.workedDays + totals.C + totals.D + totals.F + totals.LM + totals.LAO;
         if(totalAssigned !== numDaysInMonth){
            console.warn(`ALERT: Employee ${emp.name} (${emp.id}) total days mismatch. Assigned: ${totalAssigned}, Month Days: ${numDaysInMonth}. (May indicate unassigned/edited days)`);
         }
    });
}


export function validateSchedule(schedule: Schedule, employees: Employee[], absences: Absence[], holidays: Holiday[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const employeeMap = new Map(employees.map(e => [e.id, e]));

  // --- Priority Rules ---

  // Prio 1: Absences & Fixed Assignments
  let prio1Passed = true;
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
                           rule: `Priority 1 - Absence Conflict (${employee.name} on ${day.date})`,
                           passed: false,
                           details: `Failed: Expected ${absence.type} (defined absence), found ${day.shifts[absence.employeeId]}`,
                       });
                       prio1Passed = false;
                   }
               }
           });
        } catch (e) { /* ignore date parsing errors here, handled elsewhere */ }
   });
    employees.forEach(emp => {
        emp.preferences?.fixedAssignments?.forEach(fixed => {
            const day = schedule.days.find(d => d.date === fixed.date);
            if (day && day.shifts[emp.id] !== fixed.shift && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') {
                 results.push({
                    rule: `Priority 1 - Fixed Assignment Conflict (${emp.name} on ${fixed.date})`,
                    passed: false,
                    details: `Failed: Expected ${fixed.shift} (defined preference), found ${day.shifts[emp.id]}`,
                 });
                 prio1Passed = false;
            }
        });
         emp.preferences?.fixedDaysOff?.forEach(fixedD => {
             const day = schedule.days.find(d => d.date === fixedD);
             if (day && day.shifts[emp.id] !== 'D' && !(day.shifts[emp.id] === 'F' && day.isHoliday) && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') {
                  results.push({
                     rule: `Priority 1 - Fixed Day Off Conflict (${emp.name} on ${fixedD})`,
                     passed: false,
                     details: `Failed: Expected D (defined preference), found ${day.shifts[emp.id]}`,
                  });
                  prio1Passed = false;
             }
         });
         const fixedW = emp.preferences?.fixedWorkShift; 
          if(fixedW){
              const { dayOfWeek: daysOfWeek, shift: fixedShift } = fixedW;
              if(Array.isArray(daysOfWeek) && fixedShift){
                  schedule.days.forEach(day => {
                       const currentDayOfWeek = getDay(parseISO(day.date));
                       const requiresFixedShift = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;
                       const actualShift = day.shifts[emp.id];

                        if(requiresFixedShift && actualShift !== fixedShift && actualShift !== 'LAO' && actualShift !== 'LM'){
                           results.push({
                              rule: `Priority 1 - Fixed Weekly Shift Conflict (${emp.name} on ${day.date})`,
                              passed: false,
                              details: `Failed: Expected ${fixedShift} (defined preference), found ${actualShift}`,
                           });
                           prio1Passed = false;
                        }
                         if(!requiresFixedShift && (actualShift === 'M' || actualShift === 'T') && !day.isHoliday && actualShift !== 'LAO' && actualShift !== 'LM'){
                             results.push({
                                rule: `Priority 1 - Fixed Weekly Shift Conflict (${emp.name} on ${day.date})`,
                                passed: false,
                                details: `Failed: Should not work M/T on this day (defined preference), found ${actualShift}`,
                             });
                             prio1Passed = false;
                         }
                  })
              }
          }
    });

   if (prio1Passed) {
       results.push({ rule: `Priority 1 - Absences/Fixed (Overall)`, passed: true, details: 'Passed'});
   }

  // Prio 2: Coverage & M/T Ratio
   let prio2Passed = true;
   schedule.days.forEach(day => {
     const { M, T, TPT } = day.totals;
     let dayPassed = true;
     let details = [];

     if (TPT < MIN_COVERAGE_TPT) {
       dayPassed = false;
       details.push(`TPT=${TPT} (<${MIN_COVERAGE_TPT})`);
     }
     if (M < MIN_COVERAGE_M) {
         dayPassed = false;
         details.push(`M=${M} (<${MIN_COVERAGE_M})`);
     }
     if (T < MIN_COVERAGE_T) {
          dayPassed = false;
         details.push(`T=${T} (<${MIN_COVERAGE_T})`);
     }
     if (TPT > MIN_COVERAGE_TPT && !day.isHoliday && !day.isWeekend && M <= T) {
         dayPassed = false;
         details.push(`M<=T (M=${M},T=${T}) on std work day`);
     }

     if(!dayPassed) {
         results.push({
           rule: `Priority 2 - Coverage/Ratio (${format(parseISO(day.date), 'dd/MM')})`,
           passed: false,
           details: `Failed: ${details.join(', ')}`,
         });
         prio2Passed = false;
     }
   });
   if (prio2Passed) {
        results.push({ rule: `Priority 2 - Coverage/Ratio (Overall)`, passed: true, details: 'Passed'});
    }


  // Prio 3: Target D Count & D not on Holiday
   const weekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);
   let prio3Passed = true;

   employees.forEach(emp => {
       const isOnLeaveFullMonth = absences.some(a => {
           if (a.employeeId !== emp.id || !a.startDate || !a.endDate) return false;
           try {
               const absenceStart = parseISO(a.startDate);
               const absenceEnd = parseISO(a.endDate);
               const monthStart = startOfMonth(new Date(schedule.year, schedule.month - 1));
               const monthEnd = endOfMonth(new Date(schedule.year, schedule.month - 1));
               return isValid(absenceStart) && isValid(absenceEnd) &&
                      absenceStart <= monthStart && absenceEnd >= monthEnd;
           } catch (e) { return false; }
       });

       if (isOnLeaveFullMonth) return;

       if (schedule.employeeTotals[emp.id]) {
           const actualDs = schedule.employeeTotals[emp.id].D ?? 0;
           if (actualDs !== weekendDaysInMonth) {
               results.push({
                   rule: `Priority 3 - Target D Count (${emp.name})`,
                   passed: false,
                   details: `Failed: Has ${actualDs} 'D' shifts, requires ${weekendDaysInMonth} (number of weekend days in month).`,
               });
               prio3Passed = false;
           }
       } else {
           console.warn(`Totals not found for ${emp.name} during Prio 3 D count validation.`);
           results.push({
               rule: `Priority 3 - Target D Count (${emp.name})`,
               passed: false,
               details: `Failed: Totals missing, requires ${weekendDaysInMonth}.`,
           });
           prio3Passed = false;
       }
   });
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
                     prio3Passed = false;
                 }
            })
        }
    });
     if (prio3Passed) {
       results.push({ rule: `Priority 3 - Descansos & D Target (Overall)`, passed: true, details: `Passed. Target 'D's: ${weekendDaysInMonth}.`});
     }


  // Prio 4: D/D Weekends
  let prio4Passed = true;
  let eligibleEmployeesExist = false;
  employees.forEach(emp => {
    if (!emp.eligibleWeekend) return; 
    eligibleEmployeesExist = true;
    let ddWeekends = 0;
    for (let i = 0; i < schedule.days.length - 1; i++) {
      const day1 = schedule.days[i];
      const day2 = schedule.days[i + 1];
      try {
        const date1 = parseISO(day1.date);
        const date2 = parseISO(day2.date);
        if (!isValid(date1) || !isValid(date2)) continue;

         if (getDay(date1) === 6 && getDay(date2) === 0) { 
           if ((day1.shifts[emp.id] === 'D' || day1.shifts[emp.id] === 'F') &&
               (day2.shifts[emp.id] === 'D' || day2.shifts[emp.id] === 'F')) {
             ddWeekends++;
           }
         }
      } catch(e){ continue; } 
    }
     if (ddWeekends < REQUIRED_DD_WEEKENDS) {
         results.push({
           rule: `Priority 4 - D/D Weekend (${emp.name})`,
           passed: false,
           details: `Failed: Has ${ddWeekends} (D/D or F/F), requires ${REQUIRED_DD_WEEKENDS}`,
         });
         prio4Passed = false;
     }
  });
    if (prio4Passed && eligibleEmployeesExist) {
       results.push({ rule: `Priority 4 - D/D Weekend (Overall)`, passed: true, details: 'Passed'});
   } else if (!eligibleEmployeesExist) {
        results.push({ rule: `Priority 4 - D/D Weekend (Overall)`, passed: true, details: 'N/A (No employees eligible)'});
   }


   // Prio 5: Max Consecutive Days
   let maxConsecutiveOverall = 0;
   let maxConsecutiveEmployee = '';
   let prio5PassedOverall = true;

   employees.forEach(emp => {
       let currentConsecutive = 0;
       let maxForEmployee = 0;

        const firstDayStr = schedule.days[0]?.date;
       if(firstDayStr){
            const initialConsecutive = getConsecutiveWorkDaysBefore(emp.id, firstDayStr, schedule, employees);
            currentConsecutive = initialConsecutive;
            maxForEmployee = initialConsecutive;
       } else {
            console.warn("Schedule has no days, cannot calculate consecutive days.")
            return; 
       }


       schedule.days.forEach(day => {
           const shift = day.shifts[emp.id];
           if (shift === 'M' || shift === 'T') {
               currentConsecutive++;
           } else {
                if (shift !== 'M' && shift !== 'T') {
                   maxForEmployee = Math.max(maxForEmployee, currentConsecutive);
                   currentConsecutive = 0; 
                }
           }
       });
        maxForEmployee = Math.max(maxForEmployee, currentConsecutive);

         if(maxForEmployee > maxConsecutiveOverall){
             maxConsecutiveOverall = maxForEmployee;
             maxConsecutiveEmployee = emp.name;
         }

         if (maxForEmployee > MAX_CONSECUTIVE_WORK_DAYS) {
             const empTotals = schedule.employeeTotals[emp.id];
             if(empTotals && (empTotals.workedDays > 0 || empTotals.M > 0 || empTotals.T > 0)) {
                  results.push({
                      rule: `Priority 5 - Max Consecutive Days (${emp.name})`,
                      passed: false,
                      details: `Failed: Worked ${maxForEmployee} consecutive days (Max ${MAX_CONSECUTIVE_WORK_DAYS})`,
                  });
                  prio5PassedOverall = false;
              } else if (!empTotals) {
                   console.warn(`Totals missing for ${emp.name}, cannot accurately assess Prio 5 violation`)
              }
         }
   });
    results.push({
        rule: `Priority 5 - Max Consecutive Days (Overall)`,
        passed: prio5PassedOverall,
        details: prio5PassedOverall
            ? `Passed (Max found: ${maxConsecutiveOverall})`
            : `Failed (Max found: ${maxConsecutiveOverall} by ${maxConsecutiveEmployee || 'N/A'})`,
    });


  // --- Flexible Rules Validation ---
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
        passed: t_m_violations === 0, 
        details: t_m_violations === 0 ? 'No violations detected' : `Potential Violations: ${t_m_violations} instance(s) (${t_m_details.slice(0, 3).join(', ')}${t_m_violations > 3 ? '...' : ''})`,
    });


    let staffingDeviations = 0;
     schedule.days.forEach(day => {
        const { M, T } = day.totals;
        const isWorkDay = !day.isHoliday && !day.isWeekend;
        const targetM = isWorkDay ? TARGET_M_WORKDAY : TARGET_M_WEEKEND_HOLIDAY;
        const targetT = TARGET_T; 

         if(M !== targetM || T !== targetT) {
             staffingDeviations++;
         }
     })
      results.push({
          rule: `Flexible 4 - Target Staffing (Overall)`,
          passed: true, 
          details: staffingDeviations === 0 ? 'All days met target staffing.' : `${staffingDeviations} day(s) deviated from target staffing (Target WDay: ${TARGET_M_WORKDAY}M/${TARGET_T}T, Wknd/Hol: ${TARGET_M_WEEKEND_HOLIDAY}M/${TARGET_T}T).`,
      });


    let balanceIssues = 0;
     employees.forEach(emp => {
         const empTotals = schedule.employeeTotals[emp.id];
         if (!empTotals) return; 

         if(emp.preferences?.fixedWorkShift) return;

         const { M, T } = empTotals;
         const totalShifts = M + T;
         if (totalShifts > 0) {
             const diff = Math.abs(M - T);
             const imbalanceThreshold = 3;
             if (diff > imbalanceThreshold) {
                balanceIssues++;
             }
         }
     });
       results.push({
           rule: `Flexible 5 - M/T Balance (Overall)`,
           passed: true, 
           details: balanceIssues === 0 ? 'Employee M/T counts appear balanced.' : `${balanceIssues} employee(s) show potential M/T imbalance (diff > 3).`,
       });

    employees.forEach(emp => {
        if (emp.preferences?.preferWeekendWork || emp.preferences?.preferMondayRest || emp.preferences?.preferThursdayT) {
            const prefs = emp.preferences;
            let violations: string[] = [];
            schedule.days.forEach(day => {
                try {
                     const shift = day.shifts[emp.id];
                     if (!shift) return;

                     const date = parseISO(day.date);
                     if (!isValid(date)) return;
                     const dayOfWeek = getDay(date);

                     if (prefs.preferWeekendWork && (shift === 'D' || shift === 'C' || shift === 'F') && day.isWeekend) violations.push(`Franco/Libre on preferred work weekend ${format(date, 'dd/MM')}`);
                     if (prefs.preferMondayRest && (shift === 'M' || shift === 'T') && dayOfWeek === 1 && !day.isHoliday) violations.push(`Worked on preferred rest Monday ${format(date, 'dd/MM')}`);
                     if (prefs.preferThursdayT && shift === 'M' && dayOfWeek === 4 && !day.isHoliday) violations.push(`Worked M on preferred T Thursday ${format(date, 'dd/MM')}`);
                } catch (e) { /* Ignore date errors */ }
            })
             if (violations.length > 0) {
                results.push({
                    rule: `Flexible Preference - ${emp.name}`,
                    passed: true, 
                    details: `Preference Mismatches: ${violations.slice(0,2).join(', ')}${violations.length > 2 ? '...' : ''}`
                });
            }
        }
    });

    let unassignedCount = 0;
    schedule.days.forEach(day => {
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                const isOnLeaveFullMonth = absences.some(a =>
                    a.employeeId === emp.id &&
                    isValid(parseISO(a.startDate)) && isValid(parseISO(a.endDate)) && 
                    parseISO(a.startDate) <= startOfMonth(parseISO(day.date)) &&
                    parseISO(a.endDate) >= endOfMonth(parseISO(day.date))
                );
                if(!isOnLeaveFullMonth){
                   unassignedCount++;
                }
            }
        })
    });
     if (unassignedCount > 0) {
        results.push({
            rule: "Completeness Check",
            passed: false,
            details: `Failed: ${unassignedCount} employee-day slots remain unassigned (excluding full month absences).`,
        });
    } else {
         results.push({
            rule: "Completeness Check",
            passed: true,
            details: `Passed: All employee-day slots assigned.`,
        });
    }


    results.sort((a, b) => {
         const getPrio = (rule: string): number => {
              if (rule.includes("Completeness Check")) return 0; 
             if (rule.startsWith("Priority 1")) return 1;
             if (rule.startsWith("Priority 2")) return 2;
             if (rule.startsWith("Priority 3")) return 3;
             if (rule.startsWith("Priority 4")) return 4;
             if (rule.startsWith("Priority 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6; 
             if (rule.startsWith("Flexible 5")) return 7; 
             if (rule.startsWith("Flexible 4")) return 8; 
             if (rule.startsWith("Flexible Preference")) return 9; 
             if (rule.startsWith("Flexible")) return 10; 
             if (rule.startsWith("Generator Info")) return 12;
             return 11; 
         }
         const prioA = getPrio(a.rule);
         const prioB = getPrio(b.rule);
         if (prioA !== prioB) return prioA - prioB;
          if (a.passed !== b.passed) return a.passed ? 1 : -1;
         return a.rule.localeCompare(b.rule);
     });


  return results;
}



function iterativeAssignShifts(schedule: Schedule, employees: Employee[], absences: Absence[]) {

    console.log("Starting Pass 1: Essential Coverage (M/T)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        let assignedInDay = { M: 0, T: 0 }; 
        Object.values(day.shifts).forEach(s => { 
            if (s === 'M') assignedInDay.M++;
            if (s === 'T') assignedInDay.T++;
        });

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null); 

        const assignShiftIfPossible = (shiftType: 'M' | 'T'): boolean => {
            const candidates = availableEmployees
                .filter(e => canWorkShift(e, dateStr, shiftType, schedule, employees))
                .sort((a, b) => a.id - b.id); 

            if (candidates.length > 0) {
                assignShift(candidates[0].id, dateStr, shiftType, schedule);
                assignedInDay[shiftType]++;
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
                return true;
            }
            return false;
        };

        while (assignedInDay.M < MIN_COVERAGE_M) {
            if (!assignShiftIfPossible('M')) break;
        }
        while (assignedInDay.T < MIN_COVERAGE_T) {
            if (!assignShiftIfPossible('T')) break;
        }
        while (assignedInDay.M + assignedInDay.T < MIN_COVERAGE_TPT) {
            if (assignShiftIfPossible('M')) continue;
            if (assignShiftIfPossible('T')) continue;
            console.warn(`Could not meet TPT >= ${MIN_COVERAGE_TPT} on ${dateStr}. Current M=${assignedInDay.M}, T=${assignedInDay.T}`);
            break;
        }

        if (assignedInDay.M + assignedInDay.T > MIN_COVERAGE_TPT && !day.isWeekend && !day.isHoliday) {
            while (assignedInDay.M <= assignedInDay.T) {
                if (!assignShiftIfPossible('M')) {
                     console.warn(`Could not enforce M > T rule on ${dateStr}. No more available M shifts.`);
                    break;
                }
            }
        }
    });

    console.log("Starting Pass 2: Preferred/Target Staffing");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        let currentM = Object.values(day.shifts).filter(s => s === 'M').length;
        let currentT = Object.values(day.shifts).filter(s => s === 'T').length;
        const targetM = day.isWeekend || day.isHoliday ? TARGET_M_WEEKEND_HOLIDAY : TARGET_M_WORKDAY;
        const targetT = TARGET_T;

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null);

         while (currentM < targetM) {
             const candidates = availableEmployees
                 .filter(e => canWorkShift(e, dateStr, 'M', schedule, employees))
                 .sort((a, b) => a.id - b.id);
             if (candidates.length === 0) break;
             assignShift(candidates[0].id, dateStr, 'M', schedule);
             currentM++;
             availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
         }

         while (currentT < targetT) {
             const candidates = availableEmployees
                 .filter(e => canWorkShift(e, dateStr, 'T', schedule, employees))
                 .sort((a, b) => a.id - b.id);
             if (candidates.length === 0) break;
             assignShift(candidates[0].id, dateStr, 'T', schedule);
             currentT++;
             availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
         }
    });


    console.log("Starting Pass 3: Assign Rests (D, F, C) aiming for target D count");
    const weekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);
    const employeeCurrentDTotals: { [empId: number]: number } = {};
    employees.forEach(emp => employeeCurrentDTotals[emp.id] = 0);

    // Pre-count D shifts from fixed assignments or absences already set
    schedule.days.forEach(day => {
        employees.forEach(emp => {
            if (day.shifts[emp.id] === 'D') {
                employeeCurrentDTotals[emp.id]++;
            }
        });
    });

    schedule.days.forEach(day => {
         const dateStr = day.date;
         employees.forEach(emp => {
             if (day.shifts[emp.id] === null) { // If still unassigned
                const isOnLeaveFullMonth = absences.some(a => {
                    if(a.employeeId !== emp.id || !a.startDate || !a.endDate) return false;
                    try {
                        const absenceStart = parseISO(a.startDate);
                        const absenceEnd = parseISO(a.endDate);
                        const monthStart = startOfMonth(new Date(schedule.year, schedule.month - 1));
                        const monthEnd = endOfMonth(new Date(schedule.year, schedule.month - 1));
                        return isValid(absenceStart) && isValid(absenceEnd) &&
                               absenceStart <= monthStart && absenceEnd >= monthEnd;
                    } catch (e) { return false; }
                });

                if (isOnLeaveFullMonth) return; // Skip employees on full month leave for D assignment


                 if (day.isHoliday) {
                     assignShift(emp.id, dateStr, 'F', schedule);
                 }
                 // Try to assign D if employee still needs more Ds and D is possible
                 else if (employeeCurrentDTotals[emp.id] < weekendDaysInMonth && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                      assignShift(emp.id, dateStr, 'D', schedule);
                      if (day.shifts[emp.id] === 'D') { // Check if D was successfully assigned
                         employeeCurrentDTotals[emp.id]++;
                      }
                 }
                 // Fallback to C if D not needed/possible, and C is possible
                 else if (canWorkShift(emp, dateStr, 'C', schedule, employees)) {
                     assignShift(emp.id, dateStr, 'C', schedule);
                 }
                 // If still unassigned (e.g., D was needed but not possible, C not possible), try D again as a last resort if possible
                 else if (canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                    assignShift(emp.id, dateStr, 'D', schedule);
                     if (day.shifts[emp.id] === 'D') {
                         employeeCurrentDTotals[emp.id]++;
                     }
                 }
                  else {
                      console.warn(`Could not assign any rest shift (D/F/C) to ${emp.name} on ${dateStr}. Slot remains empty.`);
                 }
             }
         });
     });

     // --- Pass 4: Final Check / Cleanup (Optional) ---
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
  const employeesForGeneration: Employee[] = JSON.parse(JSON.stringify(initialEmployees));
  currentEmployeesState = employeesForGeneration; 

  const startTime = performance.now();
  const schedule = initializeSchedule(year, month, employeesForGeneration, holidays);
  console.log("Initialized schedule structure.");

  console.log("Applying absences...");
  applyAbsences(schedule, absences, employeesForGeneration);
  console.log("Applying fixed assignments/preferences...");
  applyFixedAssignments(schedule, employeesForGeneration);

  console.log("Starting iterative assignment passes...");
  iterativeAssignShifts(schedule, employeesForGeneration, absences);
  console.log("Finished iterative assignment passes.");

  console.log("Calculating final totals...");
  calculateFinalTotals(schedule, employeesForGeneration);

  console.log("Validating final schedule...");
  const report = validateSchedule(schedule, employeesForGeneration, absences, holidays);
  const endTime = performance.now();
  console.log(`Schedule generation completed in ${(endTime - startTime).toFixed(2)} ms`);

   report.push({ rule: "Generator Info", passed: true, details: `Generation took ${(endTime - startTime).toFixed(2)} ms` });

    report.sort((a, b) => {
         const getPrio = (rule: string): number => {
             if (rule.includes("Completeness Check")) return 0;
             if (rule.startsWith("Priority 1")) return 1;
             if (rule.startsWith("Priority 2")) return 2;
             if (rule.startsWith("Priority 3")) return 3;
             if (rule.startsWith("Priority 4")) return 4;
             if (rule.startsWith("Priority 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6;
             if (rule.startsWith("Flexible 5")) return 7;
             if (rule.startsWith("Flexible 4")) return 8;
             if (rule.startsWith("Flexible Preference")) return 9;
             if (rule.startsWith("Flexible")) return 10;
             if (rule.startsWith("Generator Info")) return 12;
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
