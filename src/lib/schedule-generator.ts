

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
    if (!employee || !absence.startDate || !absence.endDate) return;

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
                 day.shifts[absence.employeeId] = absence.type;
          }
        });
    } catch (e) {
         console.error(`Error processing absence for employee ${employee.name}:`, e);
    }
  });
}

function applyFixedAssignments(schedule: Schedule, employees: Employee[]) {
    employees.forEach(employee => {
        const prefs = employee.preferences || {};

        if (prefs.fixedAssignments) {
            prefs.fixedAssignments.forEach(assignment => {
                 if (!assignment.date || !assignment.shift) return;
                 try {
                    if (!isValid(parseISO(assignment.date))) return;
                    const dayIndex = schedule.days.findIndex(d => d.date === assignment.date);
                    if (dayIndex !== -1 && (schedule.days[dayIndex].shifts[employee.id] === null || !['LAO', 'LM'].includes(schedule.days[dayIndex].shifts[employee.id]!))) {
                       schedule.days[dayIndex].shifts[employee.id] = assignment.shift;
                    }
                 } catch (e) {
                    console.warn(`Skipping invalid fixed assignment date for ${employee.name}: ${assignment.date}`)
                 }
            });
        }

         if (prefs.fixedDaysOff) {
            prefs.fixedDaysOff.forEach(dateOff => {
                 if (!dateOff) return;
                 try {
                    if (!isValid(parseISO(dateOff))) return;
                     const dayIndex = schedule.days.findIndex(d => d.date === dateOff);
                     if (dayIndex !== -1 && (schedule.days[dayIndex].shifts[employee.id] === null || !['LAO', 'LM'].includes(schedule.days[dayIndex].shifts[employee.id]!))) {
                        if (!schedule.days[dayIndex].isHoliday) {
                            schedule.days[dayIndex].shifts[employee.id] = 'D';
                        } else {
                            console.warn(`Cannot assign fixed 'D' to ${employee.name} on holiday ${dateOff}. Assigning 'F' instead.`);
                            schedule.days[dayIndex].shifts[employee.id] = 'F';
                        }
                     }
                 } catch (e) {
                      console.warn(`Skipping invalid fixed day off date for ${employee.name}: ${dateOff}`)
                 }
            })
         }

         if (prefs.fixedWorkShift) {
            const { dayOfWeek: daysOfWeek, shift } = prefs.fixedWorkShift;
            if(Array.isArray(daysOfWeek) && shift) {
                schedule.days.forEach(day => {
                     if (day.shifts[employee.id] === null) { // Only apply if not already set by absence or other fixed assignment
                         const currentDate = parseISO(day.date);
                         const currentDayOfWeek = getDay(currentDate); // 0 (Sunday) to 6 (Saturday)
                         if (daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday) {
                             day.shifts[employee.id] = shift;
                         }
                     }
                })
            }
         }
    });
}


function getConsecutiveWorkDaysBefore(employeeId: number, dateStr: string, schedule: Schedule, employees: Employee[]): number {
    const employee = employees.find(e => e.id === employeeId);
    if (!employee) return 0;

    let consecutiveDays = 0;
    let currentDate: Date;
     try {
       currentDate = subDays(parseISO(dateStr), 1);
       if (!isValid(currentDate)) return 0;
     } catch (e) {
        return 0;
     }

    const scheduleStartDate = parseISO(schedule.days[0].date);
    while (currentDate >= scheduleStartDate) {
        const currentDayStr = format(currentDate, 'yyyy-MM-dd');
        const daySchedule = schedule.days.find(d => d.date === currentDayStr);
        const shift = daySchedule?.shifts[employeeId];

        if (shift === 'M' || shift === 'T') {
            consecutiveDays++;
        } else {
            return consecutiveDays;
        }
        currentDate = subDays(currentDate, 1);
    }

    const history = employee.history || {};
    const historyDates = Object.keys(history).sort().reverse();

    for(const histDateStr of historyDates){
         try {
             const histDate = parseISO(histDateStr);
              if (!isValid(histDate)) continue;

              if(format(currentDate, 'yyyy-MM-dd') !== histDateStr) {
                  return consecutiveDays; // History is not contiguous with current loop
              };
             const shift = history[histDateStr];
              if (shift === 'M' || shift === 'T') {
                 consecutiveDays++;
                 currentDate = subDays(currentDate, 1);
             } else {
                 return consecutiveDays;
             }
         } catch (e) {
              console.warn(`Error parsing history date ${histDateStr} for employee ${employee.name}. Skipping.`);
              return consecutiveDays; // Return what we have if history is malformed
         }
    }
    return consecutiveDays;
}


function canWorkShift(employee: Employee, dateStr: string, shift: ShiftType | null, schedule: Schedule, employees: Employee[]): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    if (!day) return false;

    if(shift === null) return true; // Can always "unassign"

     // Check if already on LAO/LM
     const existingShift = day.shifts[employee.id];
     if ((existingShift === 'LAO' || existingShift === 'LM') && existingShift !== shift) {
         return false; // Cannot overwrite LAO/LM with a work shift
     }

    // Rule 1: Max consecutive work days
    if ((shift === 'M' || shift === 'T')) {
        const consecutiveBefore = getConsecutiveWorkDaysBefore(employee.id, dateStr, schedule, employees);
        if (consecutiveBefore >= MAX_CONSECUTIVE_WORK_DAYS) {
            //  console.log(`Blocked ${employee.name} on ${dateStr} for ${shift}: consecutive days limit (${consecutiveBefore} >= ${MAX_CONSECUTIVE_WORK_DAYS})`);
             return false;
        }
    }

    // Rule 2: Cannot assign 'D' on a holiday
    if (shift === 'D' && day.isHoliday) {
        // console.log(`Blocked ${employee.name} on ${dateStr} for D: is a holiday`);
        return false;
    }


    // Rule 3: Fixed Assignments/Days Off/Work Shifts from preferences
    const prefs = employee.preferences || {};
    // If there's a fixed assignment for this day and it's different from the proposed shift
    if (prefs.fixedAssignments?.some(a => a.date === dateStr && a.shift !== shift)) {
         if(existingShift !== 'LAO' && existingShift !== 'LM'){ // Allow if current is LAO/LM and we are trying to assign LAO/LM again
            // console.log(`Blocked ${employee.name} on ${dateStr} for ${shift}: fixed assignment conflict`);
            return false;
         }
     }
     // If this day is a fixed day off and the proposed shift is a work shift
     if (prefs.fixedDaysOff?.includes(dateStr) && (shift === 'M' || shift === 'T')) {
           if(existingShift !== 'LAO' && existingShift !== 'LM'){
            //    console.log(`Blocked ${employee.name} on ${dateStr} for ${shift}: fixed day off conflict`);
              return false;
           }
      }
      // If this day is a fixed day off, but the shift is not D (and not F on a holiday)
      if (prefs.fixedDaysOff?.includes(dateStr) && shift !== 'D') {
           if (!(shift === 'F' && day.isHoliday) && shift !== 'LAO' && shift !== 'LM') { // Allow F on holiday, or if LAO/LM
            //    console.log(`Blocked ${employee.name} on ${dateStr} for ${shift}: fixed day off conflict (not D/F)`);
               return false;
           }
      }


       if(prefs.fixedWorkShift){
         const { dayOfWeek: daysOfWeek, shift: fixedShiftValue } = prefs.fixedWorkShift;
         if(Array.isArray(daysOfWeek) && fixedShiftValue) {
             const currentDayOfWeek = getDay(parseISO(dateStr));
             const requiresFixedShift = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

             // If this day requires a specific fixed shift, and the proposed shift is different
             if(requiresFixedShift && shift !== fixedShiftValue){
                 if(existingShift !== 'LAO' && existingShift !== 'LM'){
                    // console.log(`Blocked ${employee.name} on ${dateStr} for ${shift}: fixed weekly shift conflict`);
                    return false;
                 }
             }
             // If this day *doesn't* require a fixed shift (i.e., it's not one of the specified daysOfWeek or it's a holiday),
             // but the employee has a fixed work shift defined (implying other days they might be off, especially if not eligibleWeekend)
             // This part is tricky: does fixedWorkShift imply they *cannot* work other days?
             // For someone like Alamo (not eligibleWeekend, fixed M-F 'M'), this implies Sat/Sun should be off.
             // For now, this only enforces the *positive* assignment. Negative (cannot work other days) is handled by lack of availability or D/C assignment.
         }
       }


    // Rule 4: No T followed immediately by M
    if (shift === 'M') {
        const prevDate = subDays(parseISO(dateStr), 1);
        const prevDateStr = format(prevDate, 'yyyy-MM-dd');
        const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
        let prevShift: ShiftType | null = null;

        if (prevDaySchedule) {
            prevShift = prevDaySchedule.shifts[employee.id];
        } else {
            // Check history for the day before the schedule starts
             prevShift = employee.history?.[prevDateStr] || null;
        }

        if (prevShift === 'T') {
            // console.log(`Blocked ${employee.name} on ${dateStr} for M: previous day was T`);
            // This is a flexible rule, so for now, canWorkShift will allow it, and validation will report it.
            // If it needs to be a hard block: return false;
        }
    }

    return true;
}

// Global variable to hold current employees state for assignShift and canWorkShift
let currentEmployeesState: Employee[] = [];

function assignShift(employeeId: number, dateStr: string, shift: ShiftType | null, schedule: Schedule) {
  const day = schedule.days.find(d => d.date === dateStr);
  if (!day) return;

  const currentShift = day.shifts[employeeId];

  // Allow assignment if:
  // 1. Current slot is null OR
  // 2. Proposed shift is null (clearing a shift) OR
  // 3. Current slot is not LAO/LM (to prevent overwriting fixed absences with generated shifts)
  if (currentShift === null || shift === null || (currentShift !== 'LAO' && currentShift !== 'LM')) {
      const employee = currentEmployeesState.find(e => e.id === employeeId);
      if (employee && canWorkShift(employee, dateStr, shift, schedule, currentEmployeesState)) {
           day.shifts[employeeId] = shift;
      } else {
          // console.warn(`CANNOT ASSIGN: ${employee?.name} on ${dateStr} for ${shift} due to canWorkShift rules.`);
      }
  } else if(currentShift === 'LAO' || currentShift === 'LM') {
       // If current is LAO/LM, only allow overwriting if the new shift is the SAME LAO/LM (idempotent)
       // Or if the new shift is null (manual clearing)
       if(shift !== currentShift && shift !== null) {
           // console.warn(`Assignment blocked: Cannot overwrite ${currentShift} with ${shift} for employee ${employeeId} on ${dateStr}.`);
       } else if (shift === null) {
           day.shifts[employeeId] = null; // Allow manual clearing of LAO/LM
       }
  }
}


export function calculateFinalTotals(schedule: Schedule, employees: Employee[], absences?: Absence[]) {
  // Reset daily totals
  schedule.days.forEach(day => {
    day.totals = { M: 0, T: 0, D: 0, C: 0, F: 0, LM: 0, LAO: 0, TPT: 0 };
  });
  // Reset employee totals
   employees.forEach(emp => {
        if (!schedule.employeeTotals[emp.id]) {
            // This case should ideally not happen if initialized correctly
             schedule.employeeTotals[emp.id] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, C: 0, D: 0, LM: 0, LAO: 0 };
        } else {
            // Reset all counters to 0
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
        return; // Skip this day if date is invalid
    }

    const dayOfWeek = getDay(date); // 0 (Sunday) to 6 (Saturday)

    Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
        const empId = parseInt(empIdStr);
        const empTotals = schedule.employeeTotals[empId]; // Should exist due to reset above
        if (!empTotals) {
            console.warn(`Employee totals not found for ID ${empId} during final calculation. This is unexpected after initialization/reset.`);
            return; // Skip if somehow empTotals is still undefined
        }
         const currentEmpTotals = schedule.employeeTotals[empId]; // Alias for clarity

        // Increment daily totals and employee-specific totals
        if (shift === 'M') { day.totals.M++; currentEmpTotals.M++; currentEmpTotals.workedDays++; }
        else if (shift === 'T') { day.totals.T++; currentEmpTotals.T++; currentEmpTotals.workedDays++; }
        else if (shift === 'D') { day.totals.D++; currentEmpTotals.D++; }
        else if (shift === 'C') { day.totals.C++; currentEmpTotals.C++; }
        else if (shift === 'F') { day.totals.F++; currentEmpTotals.F++; }
        else if (shift === 'LM') { day.totals.LM++; currentEmpTotals.LM++; }
        else if (shift === 'LAO') { day.totals.LAO++; currentEmpTotals.LAO++; }

        // Track free weekends based on any non-working shift
         if (dayOfWeek === 6 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSaturdays++; // Saturday is 6
         if (dayOfWeek === 0 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSundays++; // Sunday is 0

    });
    // Calculate TPT for the day
     day.totals.TPT = day.totals.M + day.totals.T;
  });

    // Sanity check: Ensure each employee has an assignment for every day of the month, unless on full month leave
    employees.forEach(emp => {
         const totals = schedule.employeeTotals[emp.id];
         if (!totals) {
             console.warn(`Totals missing for employee ${emp.name} (${emp.id}) during final verification.`);
             return;
         }
         const totalAssignedShiftsOrAbsences = totals.workedDays + totals.C + totals.D + totals.F + totals.LM + totals.LAO;

         if(totalAssignedShiftsOrAbsences !== numDaysInMonth){
             // Check if the employee is on leave for the entire month
             const isOnLeaveFullMonth = absences?.some(a => {
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

             if (!isOnLeaveFullMonth) {
                console.warn(`ALERTA: Empleado ${emp.name} (${emp.id}) desajuste de días totales. Asignados: ${totalAssignedShiftsOrAbsences}, Días del Mes: ${numDaysInMonth}`);
             }
         }
    });
}


export function validateSchedule(schedule: Schedule, employees: Employee[], absences: Absence[], holidays: Holiday[]): ValidationResult[] {
  const results: ValidationResult[] = [];
  const employeeMap = new Map(employees.map(e => [e.id, e]));

  // Prio 1: Absences & Fixed Assignments (Implicitly checked by application, but verify)
  // Example: Verify LAO/LM are still set correctly
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
                           rule: `Prioridad 1 - Conflicto de Ausencia (${employee.name} en ${format(parseISO(day.date), 'dd/MM')})`,
                           passed: false,
                           details: `Falló: Esperado ${absence.type} (ausencia definida), encontrado ${day.shifts[absence.employeeId] ?? 'NULO'}`,
                       });
                       prio1Passed = false;
                   }
               }
           });
        } catch (e) { /* ignore */ }
   });
    employees.forEach(emp => {
        emp.preferences?.fixedAssignments?.forEach(fixed => {
            const day = schedule.days.find(d => d.date === fixed.date);
            // Check if the assigned shift is different, AND it's not an overriding LAO/LM
            if (day && day.shifts[emp.id] !== fixed.shift && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') {
                 results.push({
                    rule: `Prioridad 1 - Conflicto de Asignación Fija (${emp.name} en ${format(parseISO(fixed.date), 'dd/MM')})`,
                    passed: false,
                    details: `Falló: Esperado ${fixed.shift} (preferencia definida), encontrado ${day.shifts[emp.id] ?? 'NULO'}`,
                 });
                 prio1Passed = false;
            }
        });
         emp.preferences?.fixedDaysOff?.forEach(fixedD => {
             const day = schedule.days.find(d => d.date === fixedD);
             // Check if not D, and not F on holiday, and not LAO/LM
             if (day && day.shifts[emp.id] !== 'D' && !(day.shifts[emp.id] === 'F' && day.isHoliday) && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') {
                  results.push({
                     rule: `Prioridad 1 - Conflicto de Franco Fijo (${emp.name} en ${format(parseISO(fixedD), 'dd/MM')})`,
                     passed: false,
                     details: `Falló: Esperado D (preferencia definida), encontrado ${day.shifts[emp.id] ?? 'NULO'}`,
                  });
                  prio1Passed = false;
             }
         });
         // Check fixed weekly schedule
         const fixedW = emp.preferences?.fixedWorkShift;
          if(fixedW){
              const { dayOfWeek: daysOfWeek, shift: fixedShift } = fixedW;
              if(Array.isArray(daysOfWeek) && fixedShift){
                  schedule.days.forEach(day => {
                       const currentDayOfWeek = getDay(parseISO(day.date));
                       const requiresFixedShift = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;
                       const actualShift = day.shifts[emp.id];

                        // If it's a day for fixed shift, but actual is different (and not LAO/LM)
                        if(requiresFixedShift && actualShift !== fixedShift && actualShift !== 'LAO' && actualShift !== 'LM'){
                           results.push({
                              rule: `Prioridad 1 - Conflicto Turno Semanal Fijo (${emp.name} en ${format(parseISO(day.date), 'dd/MM')})`,
                              passed: false,
                              details: `Falló: Esperado ${fixedShift} (preferencia), encontrado ${actualShift ?? 'NULO'}`,
                           });
                           prio1Passed = false;
                        }
                        // If it's NOT a day for fixed shift, but employee is working (M/T), and they are not eligible for weekend (e.g. Alamo)
                        // This implies they should only work their fixed schedule.
                         if(!requiresFixedShift && (actualShift === 'M' || actualShift === 'T') && !day.isHoliday && actualShift !== 'LAO' && actualShift !== 'LM' && emp.eligibleWeekend === false){
                             results.push({
                                rule: `Prioridad 1 - Conflicto Turno Semanal Fijo (${emp.name} en ${format(parseISO(day.date), 'dd/MM')})`,
                                passed: false,
                                details: `Falló: No debería trabajar M/T este día (preferencia de turno fijo), encontrado ${actualShift ?? 'NULO'}`,
                             });
                             prio1Passed = false;
                         }
                  })
              }
          }
    });

   if (prio1Passed) {
       results.push({ rule: `Prioridad 1 - Ausencias/Fijos (General)`, passed: true, details: 'Pasó'});
   }


  // Prio 2: Min coverage & M/T ratio on workdays
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
     // On standard workdays, if TPT > min coverage, M should generally be > T
     if (TPT > MIN_COVERAGE_TPT && !day.isHoliday && !day.isWeekend && M <= T) {
         dayPassed = false;
         details.push(`M<=T (M=${M},T=${T}) en día laboral estándar con TPT>${MIN_COVERAGE_TPT}`);
     }

     if(!dayPassed) {
         results.push({
           rule: `Prioridad 2 - Cobertura/Ratio (${format(parseISO(day.date), 'dd/MM')})`,
           passed: false,
           details: `Falló: ${details.join(', ')}`,
         });
         prio2Passed = false;
     }
   });
   if (prio2Passed) {
        results.push({ rule: `Prioridad 2 - Cobertura/Ratio (General)`, passed: true, details: 'Pasó'});
    }


  // Prio 3: Correct number of 'D' days (equal to weekend days in month) and no 'D' on holidays
   const weekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);
   let prio3Passed = true;

   employees.forEach(emp => {
       // Skip if employee is on leave for the entire month
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

       if (isOnLeaveFullMonth) return; // Skip D count check for employees on full month leave

       if (schedule.employeeTotals[emp.id]) {
           const actualDs = schedule.employeeTotals[emp.id].D ?? 0;
           if (actualDs !== weekendDaysInMonth) {
               results.push({
                   rule: `Prioridad 3 - Cantidad D Objetivo (${emp.name})`,
                   passed: false,
                   details: `Falló: Tiene ${actualDs} 'D', requiere ${weekendDaysInMonth} (días de finde en mes).`,
               });
               prio3Passed = false;
           }
       } else {
           // This should not happen if totals are calculated
           console.warn(`Totales no encontrados para ${emp.name} durante validación Prio 3 D.`);
           results.push({
               rule: `Prioridad 3 - Cantidad D Objetivo (${emp.name})`,
               passed: false,
               details: `Falló: Faltan totales, requiere ${weekendDaysInMonth}.`,
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
                         rule: `Prioridad 3 - D en Feriado (${employee?.name || empIdStr} en ${format(parseISO(day.date), 'dd/MM')})`,
                         passed: false,
                         details: `Falló: ${employee?.name || `Emp ${empId}`} tiene D en feriado ${day.date}`,
                     });
                     prio3Passed = false;
                 }
            })
        }
    });
     if (prio3Passed) {
       results.push({ rule: `Prioridad 3 - Descansos & D Objetivo (General)`, passed: true, details: `Pasó. 'D' Objetivo: ${weekendDaysInMonth}.`});
     }


  // Prio 4: At least one D/D (or F/F on holiday weekend) weekend for eligible employees
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

        // Check if day1 is Saturday and day2 is Sunday
         if (getDay(date1) === 6 && getDay(date2) === 0) { // Saturday is 6, Sunday is 0
           if ((day1.shifts[emp.id] === 'D' || day1.shifts[emp.id] === 'F') &&
               (day2.shifts[emp.id] === 'D' || day2.shifts[emp.id] === 'F')) {
             ddWeekends++;
           }
         }
      } catch(e){ continue; }
    }
     if (ddWeekends < REQUIRED_DD_WEEKENDS) {
         results.push({
           rule: `Prioridad 4 - Finde D/D (${emp.name})`,
           passed: false,
           details: `Falló: Tiene ${ddWeekends} (D/D o F/F), requiere ${REQUIRED_DD_WEEKENDS}`,
         });
         prio4Passed = false;
     }
  });
    if (prio4Passed && eligibleEmployeesExist) {
       results.push({ rule: `Prioridad 4 - Finde D/D (General)`, passed: true, details: 'Pasó'});
   } else if (!eligibleEmployeesExist) {
        results.push({ rule: `Prioridad 4 - Finde D/D (General)`, passed: true, details: 'N/A (No hay empleados elegibles)'});
   }

  // Prio 5: Max consecutive work days
   let maxConsecutiveOverall = 0;
   let maxConsecutiveEmployee = '';
   let prio5PassedOverall = true;

   employees.forEach(emp => {
       let currentConsecutive = 0;
       let maxForEmployee = 0;

       // Initialize currentConsecutive with history before the schedule starts
        const firstDayStr = schedule.days[0]?.date;
       if(firstDayStr){
            const initialConsecutive = getConsecutiveWorkDaysBefore(emp.id, firstDayStr, schedule, employees);
            currentConsecutive = initialConsecutive;
            maxForEmployee = initialConsecutive; // Initialize maxForEmployee with this value
       } else {
            // Should not happen if schedule is initialized
            console.warn("Horario no tiene días, no se puede calcular días consecutivos.")
            return;
       }


       schedule.days.forEach(day => {
           const shift = day.shifts[emp.id];
           if (shift === 'M' || shift === 'T') {
               currentConsecutive++;
           } else {
                // Only reset if it's a non-working shift (D, C, F, LAO, LM) or null
                if (shift !== 'M' && shift !== 'T') {
                   maxForEmployee = Math.max(maxForEmployee, currentConsecutive);
                   currentConsecutive = 0;
                }
           }
       });
       // Final check after iterating all days for the current employee
        maxForEmployee = Math.max(maxForEmployee, currentConsecutive);


         if(maxForEmployee > maxConsecutiveOverall){
             maxConsecutiveOverall = maxForEmployee;
             maxConsecutiveEmployee = emp.name;
         }

         if (maxForEmployee > MAX_CONSECUTIVE_WORK_DAYS) {
             const empTotals = schedule.employeeTotals[emp.id];
             // Only report if the employee actually worked (to avoid false positives for full-month LAO/LM)
             if(empTotals && (empTotals.workedDays > 0 || empTotals.M > 0 || empTotals.T > 0)) {
                  results.push({
                      rule: `Prioridad 5 - Máx Días Consecutivos (${emp.name})`,
                      passed: false,
                      details: `Falló: Trabajó ${maxForEmployee} días consecutivos (Máx ${MAX_CONSECUTIVE_WORK_DAYS})`,
                  });
                  prio5PassedOverall = false;
              } else if (!empTotals) {
                   console.warn(`Faltan totales para ${emp.name}, no se puede evaluar Prio 5 con precisión`)
              }
         }
   });
    results.push({
        rule: `Prioridad 5 - Máx Días Consecutivos (General)`,
        passed: prio5PassedOverall,
        details: prio5PassedOverall
            ? `Pasó (Máx encontrado: ${maxConsecutiveOverall})`
            : `Falló (Máx encontrado: ${maxConsecutiveOverall} por ${maxConsecutiveEmployee || 'N/A'})`,
    });


    // Flexible Rule 1: T followed by M (12h rest)
    let t_m_violations = 0;
    let t_m_details: string[] = [];
     employees.forEach(emp => {
         for (let i = 0; i < schedule.days.length; i++) {
              try {
                 const currentDayDateStr = schedule.days[i].date;
                 const currentShift = schedule.days[i].shifts[emp.id];

                 if (currentShift === 'M') {
                     // Check previous day
                      const prevDate = subDays(parseISO(currentDayDateStr), 1);
                      const prevDateStr = format(prevDate, 'yyyy-MM-dd');
                      const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
                      let prevShift: ShiftType | null = null;
                      if (prevDaySchedule) {
                          prevShift = prevDaySchedule.shifts[emp.id];
                      } else {
                          // Check history if it's the first day of the schedule
                          prevShift = emp.history?.[prevDateStr] || null;
                      }

                     if (prevShift === 'T') {
                        t_m_violations++;
                        t_m_details.push(`${emp.name} en ${format(parseISO(currentDayDateStr), 'dd/MM')}`);
                     }
                 }
              } catch (e) { /* Ignore date parsing errors for robust validation */ }
         }
     })
      results.push({
        rule: `Flexible 1 - Descanso T->M 12h`,
        passed: t_m_violations === 0, // Considered "passed" if no hard violations, but still noted
        details: t_m_violations === 0 ? 'No se detectaron violaciones' : `Violaciones Potenciales: ${t_m_violations} instancia(s) (${t_m_details.slice(0, 3).join(', ')}${t_m_violations > 3 ? '...' : ''})`,
    });

    // Flexible Rule 4: Target staffing levels
    let staffingDeviations = 0;
     schedule.days.forEach(day => {
        const { M, T } = day.totals;
        const isWorkDay = !day.isHoliday && !day.isWeekend;
        const targetM = isWorkDay ? TARGET_M_WORKDAY : TARGET_M_WEEKEND_HOLIDAY;
        const targetT = TARGET_T; // Target T is usually consistent

         if(M !== targetM || T !== targetT) {
             staffingDeviations++;
         }
     })
      results.push({
          rule: `Flexible 4 - Dotación Objetivo (General)`,
          passed: true, // Always true as it's flexible, details provide info
          details: staffingDeviations === 0 ? 'Todos los días cumplieron dotación objetivo.' : `${staffingDeviations} día(s) se desviaron de la dotación objetivo (Obj Día Lab: ${TARGET_M_WORKDAY}M/${TARGET_T}T, Finde/Fer: ${TARGET_M_WEEKEND_HOLIDAY}M/${TARGET_T}T).`,
      });

    // Flexible Rule 5: M/T balance for employees (excluding those with fixed weekly shifts)
    let balanceIssues = 0;
     employees.forEach(emp => {
         const empTotals = schedule.employeeTotals[emp.id];
         if (!empTotals) return; // Skip if no totals (should not happen)

         // Skip if employee has a fixed weekly work shift defined, as their M/T counts will be skewed by that
         if(emp.preferences?.fixedWorkShift) return;

         const { M, T } = empTotals;
         const totalShifts = M + T;
         if (totalShifts > 0) { // Only consider if they worked M or T at all
             const diff = Math.abs(M - T);
             const imbalanceThreshold = 3; // Example: more than 3 M's than T's, or vice-versa
             if (diff > imbalanceThreshold) {
                balanceIssues++;
             }
         }
     });
       results.push({
           rule: `Flexible 5 - Balance M/T (General)`,
           passed: true, // Always true
           details: balanceIssues === 0 ? 'Conteos M/T de empleados parecen balanceados.' : `${balanceIssues} empleado(s) muestran desbalance M/T potencial (dif > 3).`,
       });


    // Check employee-specific preferences (Flexible)
    employees.forEach(emp => {
        if (emp.preferences?.preferWeekendWork || emp.preferences?.preferMondayRest || emp.preferences?.preferThursdayT) {
            const prefs = emp.preferences;
            let violations: string[] = [];
            schedule.days.forEach(day => {
                try {
                     const shift = day.shifts[emp.id];
                     if (!shift) return; // Skip if no shift assigned

                     const date = parseISO(day.date);
                     if (!isValid(date)) return;
                     const dayOfWeek = getDay(date); // Sunday is 0, Monday is 1, ..., Saturday is 6

                     if (prefs.preferWeekendWork && (shift === 'D' || shift === 'C' || shift === 'F') && day.isWeekend) violations.push(`Franco/Libre en finde de trabajo preferido ${format(date, 'dd/MM')}`);
                     if (prefs.preferMondayRest && (shift === 'M' || shift === 'T') && dayOfWeek === 1 && !day.isHoliday) violations.push(`Trabajó en lunes de descanso preferido ${format(date, 'dd/MM')}`);
                     if (prefs.preferThursdayT && shift === 'M' && dayOfWeek === 4 && !day.isHoliday) violations.push(`Trabajó M en jueves de T preferido ${format(date, 'dd/MM')}`);
                } catch (e) { /* Ignore date parsing issues */ }
            })
             if (violations.length > 0) {
                results.push({
                    rule: `Preferencia Flexible - ${emp.name}`,
                    passed: true, // It's a preference, so always "passed" but note deviations
                    details: `Desajustes de Preferencia: ${violations.slice(0,2).join(', ')}${violations.length > 2 ? '...' : ''}`
                });
            }
        }
    });


    // Final Check: Completeness - any null shifts?
    let unassignedCount = 0;
    let unassignedDetails: string[] = [];
    schedule.days.forEach(day => {
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                // Check if employee is on full month leave for this month before counting as unassigned
                const isOnLeaveFullMonth = absences.some(a =>
                    a.employeeId === emp.id &&
                    a.startDate && a.endDate && // Ensure dates are defined
                    isValid(parseISO(a.startDate)) && isValid(parseISO(a.endDate)) &&
                    parseISO(a.startDate) <= startOfMonth(parseISO(day.date)) &&
                    parseISO(a.endDate) >= endOfMonth(parseISO(day.date))
                );
                if(!isOnLeaveFullMonth){
                   unassignedCount++;
                   if(unassignedDetails.length < 5) unassignedDetails.push(`${emp.name} en ${format(parseISO(day.date), 'dd/MM')}`);
                }
            }
        })
    });
     if (unassignedCount > 0) {
        results.push({
            rule: "Verificación de Completitud",
            passed: false,
            details: `Falló: ${unassignedCount} ranuras empleado-día siguen sin asignar (excl. ausencias mes completo). Ej: ${unassignedDetails.join(', ')}${unassignedCount > 5 ? '...' : ''}`,
        });
    } else {
         results.push({
            rule: "Verificación de Completitud",
            passed: true,
            details: `Pasó: Todas las ranuras empleado-día asignadas.`,
        });
    }


    // Sort results: Completeness first, then by priority, then by passed/failed, then alphabetically
     results.sort((a, b) => {
         const getPrio = (rule: string): number => {
              if (rule.includes("Completitud")) return 0;
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2")) return 2;
             if (rule.startsWith("Prioridad 3")) return 3;
             if (rule.startsWith("Prioridad 4")) return 4;
             if (rule.startsWith("Prioridad 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6; // T->M rest
             if (rule.startsWith("Flexible 5")) return 7; // M/T Balance
             if (rule.startsWith("Flexible 4")) return 8; // Staffing Target
             if (rule.startsWith("Preferencia Flexible")) return 9;
             if (rule.startsWith("Flexible")) return 10; // Other flexible
             if (rule.startsWith("Info Generador")) return 12; // Generator info last
             return 11; // Default for any other rule
         }
         const prioA = getPrio(a.rule);
         const prioB = getPrio(b.rule);

         if (prioA !== prioB) return prioA - prioB;
         // Within the same priority, show failed items first
          if (a.passed !== b.passed) return a.passed ? 1 : -1;
         // Then sort by rule name
         return a.rule.localeCompare(b.rule);
     });

  return results;
}


function iterativeAssignShifts(schedule: Schedule, employees: Employee[], absences: Absence[], holidays: Holiday[]) {
    const weekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);

    // --- Pass 1: Ensure Essential Coverage (M/T) ---
    console.log("Pase 1: Cobertura Esencial (M/T)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        let assignedInDay = { M: 0, T: 0 };
        // Count already assigned M/T shifts (from fixed assignments or LAO/LM)
        Object.values(day.shifts).forEach(s => {
            if (s === 'M') assignedInDay.M++;
            if (s === 'T') assignedInDay.T++;
        });

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null); // Only consider unassigned slots

        const assignShiftIfPossible = (shiftType: 'M' | 'T'): boolean => {
            const candidates = availableEmployees
                .filter(e => canWorkShift(e, dateStr, shiftType, schedule, employees))
                // Prioritize employees with fewer total worked days so far
                .sort((a, b) => (schedule.employeeTotals[a.id]?.workedDays || 0) - (schedule.employeeTotals[b.id]?.workedDays || 0));

            if (candidates.length > 0) {
                assignShift(candidates[0].id, dateStr, shiftType, schedule);
                 if (day.shifts[candidates[0].id] === shiftType) { // Check if assignShift was successful
                    assignedInDay[shiftType]++;
                    availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id); // Remove assigned employee
                    return true;
                }
            }
            return false;
        };

        // Ensure minimum M coverage
        while (assignedInDay.M < MIN_COVERAGE_M) {
            if (!assignShiftIfPossible('M')) break;
        }
        // Ensure minimum T coverage
        while (assignedInDay.T < MIN_COVERAGE_T) {
            if (!assignShiftIfPossible('T')) break;
        }
        // Ensure minimum TPT coverage
        while (assignedInDay.M + assignedInDay.T < MIN_COVERAGE_TPT) {
            // Try assigning M first, then T, if TPT is still low
            if (assignShiftIfPossible('M')) continue;
            if (assignShiftIfPossible('T')) continue;
            console.warn(`No se pudo cumplir TPT >= ${MIN_COVERAGE_TPT} en ${dateStr}. M actual=${assignedInDay.M}, T=${assignedInDay.T}`);
            break; // Cannot meet TPT minimum
        }

        // On standard workdays, if TPT > min, try to make M > T
        if (assignedInDay.M + assignedInDay.T > MIN_COVERAGE_TPT && !day.isWeekend && !day.isHoliday) {
            while (assignedInDay.M <= assignedInDay.T) {
                if (!assignShiftIfPossible('M')) {
                     console.warn(`No se pudo aplicar regla M > T en ${dateStr}. No hay más turnos M disponibles.`);
                    break;
                }
            }
        }
    });
    calculateFinalTotals(schedule, employees, absences); // Recalculate totals after Pass 1

    // --- Pass 2: Aim for Target Staffing Levels ---
    console.log("Pase 2: Dotación Preferida/Objetivo");
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
                 // Prioritize those with fewer M shifts
                 .sort((a,b) => (schedule.employeeTotals[a.id]?.M || 0) - (schedule.employeeTotals[b.id]?.M || 0));
             if (candidates.length === 0) break; // No more candidates for M
             assignShift(candidates[0].id, dateStr, 'M', schedule);
              if (day.shifts[candidates[0].id] === 'M') { // If assignment was successful
                currentM++;
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
              } else { // Shift was not assignable (canWorkShift returned false), remove from candidates for this iteration
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
              }
         }

         // Add T shifts up to target
         while (currentT < targetT) {
             const candidates = availableEmployees
                 .filter(e => canWorkShift(e, dateStr, 'T', schedule, employees))
                 // Prioritize those with fewer T shifts
                 .sort((a,b) => (schedule.employeeTotals[a.id]?.T || 0) - (schedule.employeeTotals[b.id]?.T || 0));
             if (candidates.length === 0) break; // No more candidates for T
             assignShift(candidates[0].id, dateStr, 'T', schedule);
             if (day.shifts[candidates[0].id] === 'T') { // If assignment was successful
                currentT++;
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
             } else {
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
             }
         }
    });
    calculateFinalTotals(schedule, employees, absences); // Recalculate totals after Pass 2

    // --- Pass 3: Assign Rest Days (D, F, C), aiming for D target ---
    console.log("Pase 3: Asignar Descansos (D, F, C) apuntando a D objetivo");
    const employeeCurrentDTotals: { [empId: number]: number } = {};
    employees.forEach(emp => {
        employeeCurrentDTotals[emp.id] = schedule.employeeTotals[emp.id]?.D || 0;
    });


    schedule.days.forEach(day => {
         const dateStr = day.date;
         // Sort employees: those needing D most, then those with fewer D's overall
         const employeesSortedForRest = [...employees].sort((a, b) => {
             const needsDA = employeeCurrentDTotals[a.id] < weekendDaysInMonth;
             const needsDB = employeeCurrentDTotals[b.id] < weekendDaysInMonth;

             if (needsDA && !needsDB) return -1; // A needs D more urgently
             if (!needsDA && needsDB) return 1;  // B needs D more urgently

             // If both need or don't need, prioritize by current D count (ascending)
             return (employeeCurrentDTotals[a.id]) - (employeeCurrentDTotals[b.id]);
         });


         employeesSortedForRest.forEach(emp => {
             if (day.shifts[emp.id] === null) { // Only if slot is still empty
                // Skip if employee is on leave for the entire month for this day's month
                const isOnLeaveFullMonth = absences.some(a => {
                    if(a.employeeId !== emp.id || !a.startDate || !a.endDate) return false;
                    try {
                        const absenceStart = parseISO(a.startDate);
                        const absenceEnd = parseISO(a.endDate);
                        const monthStart = startOfMonth(parseISO(day.date)); // Use day.date for month context
                        const monthEnd = endOfMonth(parseISO(day.date));
                        return isValid(absenceStart) && isValid(absenceEnd) &&
                               absenceStart <= monthStart && absenceEnd >= monthEnd;
                    } catch (e) { return false; }
                });

                if (isOnLeaveFullMonth) return; // Skip assignment for full-month leave

                 if (day.isHoliday) {
                     // On holidays, assign 'F' if possible
                     if (canWorkShift(emp, dateStr, 'F', schedule, employees)) {
                        assignShift(emp.id, dateStr, 'F', schedule);
                     }
                 }
                 // If not a holiday, try to assign 'D' if employee needs it and can take it
                 else if (employeeCurrentDTotals[emp.id] < weekendDaysInMonth && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                      assignShift(emp.id, dateStr, 'D', schedule);
                      if (day.shifts[emp.id] === 'D') { // If 'D' was successfully assigned
                         employeeCurrentDTotals[emp.id]++;
                      }
                 }
                 // If 'D' wasn't assigned (either not needed, not possible, or holiday), try 'C'
                 else if (canWorkShift(emp, dateStr, 'C', schedule, employees)) {
                     assignShift(emp.id, dateStr, 'C', schedule);
                 }
                 // As a last resort, if still null and not a holiday, assign 'D' even if target is met, if possible
                 else if (!day.isHoliday && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                    assignShift(emp.id, dateStr, 'D', schedule);
                     if (day.shifts[emp.id] === 'D') {
                         employeeCurrentDTotals[emp.id]++;
                     }
                 }
                  else {
                      // If still null, it means no valid rest shift could be assigned.
                      // This will be caught by completeness check or other validations.
                      console.warn(`No se pudo asignar turno de descanso (D/F/C) a ${emp.name} en ${dateStr}. Ranura vacía.`);
                 }
             }
         });
     });
    calculateFinalTotals(schedule, employees, absences); // Recalculate after Pass 3

    // Pass 3.5: Fill remaining nulls with C if possible, or D if not a holiday and D count allows, or F if holiday
    console.log("Pase 3.5: Llenar NULOS restantes con C, D o F");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) { // Only if slot is still empty
                const isOnLeaveFullMonth = absences.some(a => { /* ... same full month leave check ... */
                     if(a.employeeId !== emp.id || !a.startDate || !a.endDate) return false;
                    try {
                        const absenceStart = parseISO(a.startDate);
                        const absenceEnd = parseISO(a.endDate);
                        const monthStart = startOfMonth(parseISO(day.date));
                        const monthEnd = endOfMonth(parseISO(day.date));
                        return isValid(absenceStart) && isValid(absenceEnd) &&
                               absenceStart <= monthStart && absenceEnd >= monthEnd;
                    } catch (e) { return false; }
                });
                if (isOnLeaveFullMonth) return;

                if (day.isHoliday) {
                    if (canWorkShift(emp, dateStr, 'F', schedule, employees)) {
                        assignShift(emp.id, dateStr, 'F', schedule);
                    }
                } else if (canWorkShift(emp, dateStr, 'C', schedule, employees)) {
                    assignShift(emp.id, dateStr, 'C', schedule);
                } else if (employeeCurrentDTotals[emp.id] < weekendDaysInMonth && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                    assignShift(emp.id, dateStr, 'D', schedule);
                    if (day.shifts[emp.id] === 'D') employeeCurrentDTotals[emp.id]++;
                } else if (canWorkShift(emp, dateStr, 'D', schedule, employees)) { // Assign D even if target met, if C not possible
                     assignShift(emp.id, dateStr, 'D', schedule);
                     if (day.shifts[emp.id] === 'D') employeeCurrentDTotals[emp.id]++;
                }
                 else {
                    // If still null, this is problematic and should be caught by validation
                    console.warn(`Pase 3.5: Aún no se puede asignar D/C/F a ${emp.name} en ${dateStr}`);
                }
            }
        });
    });
    calculateFinalTotals(schedule, employees, absences); // Final calculation
}


export function generateSchedule(
  year: number,
  month: number,
  initialEmployees: Employee[],
  initialAbsences: Absence[], // Renamed to avoid conflict with global/module scope 'absences'
  initialHolidays: Holiday[] // Renamed for clarity
): { schedule: Schedule; report: ValidationResult[] } {

  console.log("Iniciando Generación de Horario para", { year, month });
  // Deep copy initial data to prevent modification of the original state from UI
  const employeesForGeneration: Employee[] = JSON.parse(JSON.stringify(initialEmployees));
  const absencesForGeneration: Absence[] = JSON.parse(JSON.stringify(initialAbsences));
  const holidaysForGeneration: Holiday[] = JSON.parse(JSON.stringify(initialHolidays));

  // Set the global state for employees to be used by helper functions
  currentEmployeesState = employeesForGeneration;

  const startTime = performance.now();
  const schedule = initializeSchedule(year, month, employeesForGeneration, holidaysForGeneration);
  console.log("Estructura de horario inicializada.");

  // Apply absences and fixed assignments first as they are highest priority
  console.log("Aplicando ausencias...");
  applyAbsences(schedule, absencesForGeneration, employeesForGeneration);
  console.log("Aplicando asignaciones/preferencias fijas...");
  applyFixedAssignments(schedule, employeesForGeneration);

  // Calculate initial totals AFTER absences and fixed assignments are applied
  // This ensures these fixed items are counted before iterative assignment begins
  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration);


  console.log("Iniciando pases de asignación iterativa...");
  iterativeAssignShifts(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration);
  console.log("Pases de asignación iterativa finalizados.");

  // Final calculation of all totals
  console.log("Calculando totales finales...");
  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration);

  console.log("Validando horario final...");
  const report = validateSchedule(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration);
  const endTime = performance.now();
  console.log(`Generación de horario completada en ${(endTime - startTime).toFixed(2)} ms`);

   report.push({ rule: "Info Generador", passed: true, details: `Generación tomó ${(endTime - startTime).toFixed(2)} ms` });

    // Sort report again to ensure "Info Generador" is last and completeness is first
    report.sort((a, b) => {
         const getPrio = (rule: string): number => {
             if (rule.includes("Completitud")) return 0;
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2")) return 2;
             if (rule.startsWith("Prioridad 3")) return 3;
             if (rule.startsWith("Prioridad 4")) return 4;
             if (rule.startsWith("Prioridad 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6;
             if (rule.startsWith("Flexible 5")) return 7;
             if (rule.startsWith("Flexible 4")) return 8;
             if (rule.startsWith("Preferencia Flexible")) return 9;
             if (rule.startsWith("Flexible")) return 10;
             if (rule.startsWith("Info Generador")) return 12;
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
