

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
import { differenceInDays, format, parseISO, addDays, getDay, isWeekend, startOfMonth, endOfMonth, getDate, subDays, isValid, getDaysInMonth as getNativeDaysInMonth } from 'date-fns';

// --- Constants and Configuration ---
const MAX_CONSECUTIVE_WORK_DAYS = 6;
const MAX_CONSECUTIVE_D_DAYS = 2; 
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
      totals: { M: 0, T: 0, D: 0, F: 0, LM: 0, LAO: 0, TPT: 0 },
    };
  });

  const employeeTotals: { [employeeId: number]: EmployeeTotals } = employees.reduce((acc, emp) => {
    acc[emp.id] = {
      workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0
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


function getConsecutiveShiftDaysBefore(employeeId: number, dateStr: string, schedule: Schedule, employees: Employee[], targetShiftType: 'work' | 'D'): number {
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

    // Check within current schedule
    while (currentDate >= scheduleStartDate) {
        const currentDayStr = format(currentDate, 'yyyy-MM-dd');
        const daySchedule = schedule.days.find(d => d.date === currentDayStr);
        const shift = daySchedule?.shifts[employeeId];

        if (targetShiftType === 'work' && (shift === 'M' || shift === 'T')) {
            consecutiveDays++;
        } else if (targetShiftType === 'D' && shift === 'D') {
            consecutiveDays++;
        }
         else {
            return consecutiveDays; // Streak broken
        }
        currentDate = subDays(currentDate, 1);
    }

    // Check history if streak continues before schedule start
    const history = employee.history || {};
    const historyDates = Object.keys(history).sort().reverse(); // Ensure sorted processing

    for (const histDateStr of historyDates) {
        if (format(currentDate, 'yyyy-MM-dd') !== histDateStr) {
             // If the history date is not the one immediately preceding current `currentDate`,
             // it means there's a gap, so the streak from history is not contiguous.
            return consecutiveDays;
        }
        try {
            const histDate = parseISO(histDateStr);
            if (!isValid(histDate)) continue;

            const shift = history[histDateStr];
            if (targetShiftType === 'work' && (shift === 'M' || shift === 'T')) {
                consecutiveDays++;
            } else if (targetShiftType === 'D' && shift === 'D') {
                consecutiveDays++;
            } else {
                return consecutiveDays; // Streak broken
            }
            currentDate = subDays(currentDate, 1); // Move to the day before this history entry
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
        const consecutiveBefore = getConsecutiveShiftDaysBefore(employee.id, dateStr, schedule, employees, 'work');
        if (consecutiveBefore >= MAX_CONSECUTIVE_WORK_DAYS) {
             return false;
        }
    }

    // Rule: Max consecutive 'D' days
    if (shift === 'D') {
        const consecutiveDBefore = getConsecutiveShiftDaysBefore(employee.id, dateStr, schedule, employees, 'D');
        if (consecutiveDBefore >= MAX_CONSECUTIVE_D_DAYS) {
            return false;
        }
    }


    // Rule 2: Cannot assign 'D' on a holiday
    if (shift === 'D' && day.isHoliday) {
        return false;
    }


    // Rule 3: Fixed Assignments/Days Off/Work Shifts from preferences
    const prefs = employee.preferences || {};
    if (prefs.fixedAssignments?.some(a => a.date === dateStr && a.shift !== shift)) {
         if(existingShift !== 'LAO' && existingShift !== 'LM'){
            return false;
         }
     }


       if(prefs.fixedWorkShift){
         const { dayOfWeek: daysOfWeek, shift: fixedShiftValue } = prefs.fixedWorkShift;
         if(Array.isArray(daysOfWeek) && fixedShiftValue) {
             const currentDayOfWeek = getDay(parseISO(dateStr));
             const requiresFixedShift = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

             if(requiresFixedShift && shift !== fixedShiftValue){
                 if(existingShift !== 'LAO' && existingShift !== 'LM'){
                    return false;
                 }
             }
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
             prevShift = employee.history?.[prevDateStr] || null;
        }

        if (prevShift === 'T') {
            // This is a flexible rule, so for now, canWorkShift will allow it, and validation will report it.
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

  if (currentShift === null || shift === null || (currentShift !== 'LAO' && currentShift !== 'LM')) {
      const employee = currentEmployeesState.find(e => e.id === employeeId);
      if (employee && canWorkShift(employee, dateStr, shift, schedule, currentEmployeesState)) {
           day.shifts[employeeId] = shift;
      }
  } else if(currentShift === 'LAO' || currentShift === 'LM') {
       if(shift !== currentShift && shift !== null) {
           // console.warn(`Assignment blocked: Cannot overwrite ${currentShift} with ${shift} for employee ${employeeId} on ${dateStr}.`);
       } else if (shift === null) {
           day.shifts[employeeId] = null;
       }
  }
}

function calculateEmployeeDTarget(employee: Employee, schedule: Schedule, absences: Absence[], baseWeekendDaysInMonth: number): number {
    const totalDaysInCurrentMonth = getNativeDaysInMonth(new Date(schedule.year, schedule.month - 1));
    let absenceDaysForEmployeeInMonth = 0;

    const monthStartDate = startOfMonth(new Date(schedule.year, schedule.month - 1));
    const monthEndDate = endOfMonth(new Date(schedule.year, schedule.month - 1));

    absences.forEach(absence => {
        if (absence.employeeId === employee.id && absence.startDate && absence.endDate) {
            try {
                const absenceStart = parseISO(absence.startDate);
                const absenceEnd = parseISO(absence.endDate);
                 if (!isValid(absenceStart) || !isValid(absenceEnd)) return;

                // Calculate overlap between absence period and current month
                const overlapStart = absenceStart > monthStartDate ? absenceStart : monthStartDate;
                const overlapEnd = absenceEnd < monthEndDate ? absenceEnd : monthEndDate;

                if (overlapStart <= overlapEnd) {
                    absenceDaysForEmployeeInMonth += differenceInDays(overlapEnd, overlapStart) + 1;
                }
            } catch (e) {
                 console.warn(`Error calculating absence days for D target: ${e}`);
            }
        }
    });

    const workableDays = Math.max(0, totalDaysInCurrentMonth - absenceDaysForEmployeeInMonth);
    if (totalDaysInCurrentMonth === 0) return 0; // Avoid division by zero

    const dTarget = Math.round((workableDays / totalDaysInCurrentMonth) * baseWeekendDaysInMonth);
    return Math.max(0, dTarget); // Ensure target is not negative
}


export function calculateFinalTotals(schedule: Schedule, employees: Employee[], absencesForTotals?: Absence[]) {
  schedule.days.forEach(day => {
    day.totals = { M: 0, T: 0, D: 0, F: 0, LM: 0, LAO: 0, TPT: 0 };
  });
   employees.forEach(emp => {
        if (!schedule.employeeTotals[emp.id]) {
             schedule.employeeTotals[emp.id] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0 };
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
            console.warn(`Employee totals not found for ID ${empId} during final calculation.`);
            return;
        }
         const currentEmpTotals = schedule.employeeTotals[empId];

        if (shift === 'M') { day.totals.M++; currentEmpTotals.M++; currentEmpTotals.workedDays++; }
        else if (shift === 'T') { day.totals.T++; currentEmpTotals.T++; currentEmpTotals.workedDays++; }
        else if (shift === 'D') { day.totals.D++; currentEmpTotals.D++; }
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
         const totalAssignedShiftsOrAbsences = totals.workedDays + totals.D + totals.F + totals.LM + totals.LAO;

         if(totalAssignedShiftsOrAbsences !== numDaysInMonth){
             const isOnLeaveFullMonth = absencesForTotals?.some(a => {
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
  const baseWeekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);


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
            if (day && day.shifts[emp.id] !== fixed.shift && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') {
                 results.push({
                    rule: `Prioridad 1 - Conflicto de Asignación Fija (${emp.name} en ${format(parseISO(fixed.date), 'dd/MM')})`,
                    passed: false,
                    details: `Falló: Esperado ${fixed.shift} (preferencia definida), encontrado ${day.shifts[emp.id] ?? 'NULO'}`,
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
                              rule: `Prioridad 1 - Conflicto Turno Semanal Fijo (${emp.name} en ${format(parseISO(day.date), 'dd/MM')})`,
                              passed: false,
                              details: `Falló: Esperado ${fixedShift} (preferencia), encontrado ${actualShift ?? 'NULO'}`,
                           });
                           prio1Passed = false;
                        }
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


  // Prio 3: Correct number of 'D' days (proportional) and no 'D' on holidays
   let prio3Passed = true;
   employees.forEach(emp => {
       const targetDs = calculateEmployeeDTarget(emp, schedule, absences, baseWeekendDaysInMonth);
       if (schedule.employeeTotals[emp.id]) {
           const actualDs = schedule.employeeTotals[emp.id].D ?? 0;
           if (actualDs !== targetDs) {
               results.push({
                   rule: `Prioridad 3 - Cantidad D Objetivo (${emp.name})`,
                   passed: false,
                   details: `Falló: Tiene ${actualDs} 'D', requiere ${targetDs} (proporcional a días trabajables).`,
               });
               prio3Passed = false;
           }
       } else {
           console.warn(`Totales no encontrados para ${emp.name} durante validación Prio 3 D.`);
           results.push({
               rule: `Prioridad 3 - Cantidad D Objetivo (${emp.name})`,
               passed: false,
               details: `Falló: Faltan totales, requiere ${targetDs}.`,
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
       results.push({ rule: `Prioridad 3 - Descansos & D Objetivo (General)`, passed: true, details: `Pasó. 'D' Objetivo: proporcional a días trabajables.`});
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

  // Prio 5: Max consecutive work/D days
   let maxConsecutiveWorkOverall = 0;
   let maxConsecutiveWorkEmployee = '';
   let prio5WorkPassedOverall = true;

   let maxConsecutiveDOverall = 0;
   let maxConsecutiveDEmployee = '';
   let prio5DPassedOverall = true;


   employees.forEach(emp => {
       let currentConsecutiveWork = 0;
       let maxForEmployeeWork = 0;
       let currentConsecutiveD = 0;
       let maxForEmployeeD = 0;

       const firstDayStr = schedule.days[0]?.date;
       if(firstDayStr){
            currentConsecutiveWork = getConsecutiveShiftDaysBefore(emp.id, firstDayStr, schedule, employees, 'work');
            maxForEmployeeWork = currentConsecutiveWork;
            currentConsecutiveD = getConsecutiveShiftDaysBefore(emp.id, firstDayStr, schedule, employees, 'D');
            maxForEmployeeD = currentConsecutiveD;
       } else {
            console.warn("Horario no tiene días, no se puede calcular días consecutivos.")
            return;
       }

       schedule.days.forEach(day => {
           const shift = day.shifts[emp.id];
           if (shift === 'M' || shift === 'T') {
               currentConsecutiveWork++;
               maxForEmployeeD = Math.max(maxForEmployeeD, currentConsecutiveD); // End D streak
               currentConsecutiveD = 0;
           } else if (shift === 'D') {
               currentConsecutiveD++;
               maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork); // End work streak
               currentConsecutiveWork = 0;
           } else { // Other shifts (F, LAO, LM, null) break both streaks
                maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
                currentConsecutiveWork = 0;
                maxForEmployeeD = Math.max(maxForEmployeeD, currentConsecutiveD);
                currentConsecutiveD = 0;
           }
       });
        maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
        maxForEmployeeD = Math.max(maxForEmployeeD, currentConsecutiveD);

         if(maxForEmployeeWork > maxConsecutiveWorkOverall){
             maxConsecutiveWorkOverall = maxForEmployeeWork;
             maxConsecutiveWorkEmployee = emp.name;
         }
         if (maxForEmployeeWork > MAX_CONSECUTIVE_WORK_DAYS) {
             const empTotals = schedule.employeeTotals[emp.id];
             if(empTotals && (empTotals.workedDays > 0 || empTotals.M > 0 || empTotals.T > 0)) {
                  results.push({
                      rule: `Prioridad 5 - Máx Días Consecutivos de Trabajo (${emp.name})`,
                      passed: false,
                      details: `Falló: Trabajó ${maxForEmployeeWork} días consecutivos (Máx ${MAX_CONSECUTIVE_WORK_DAYS})`,
                  });
                  prio5WorkPassedOverall = false;
              }
         }

         if(maxForEmployeeD > maxConsecutiveDOverall){
             maxConsecutiveDOverall = maxForEmployeeD;
             maxConsecutiveDEmployee = emp.name;
         }
         if (maxForEmployeeD > MAX_CONSECUTIVE_D_DAYS) {
              const empTotals = schedule.employeeTotals[emp.id];
               if(empTotals && empTotals.D > 0) { // Only report if they actually had D shifts
                    results.push({
                        rule: `Prioridad 5 - Máx Días 'D' Consecutivos (${emp.name})`,
                        passed: false,
                        details: `Falló: Tuvo ${maxForEmployeeD} 'D' consecutivos (Máx ${MAX_CONSECUTIVE_D_DAYS})`,
                    });
                    prio5DPassedOverall = false;
                }
         }
   });
    results.push({
        rule: `Prioridad 5 - Máx Días Consecutivos de Trabajo (General)`,
        passed: prio5WorkPassedOverall,
        details: prio5WorkPassedOverall
            ? `Pasó (Máx encontrado: ${maxConsecutiveWorkOverall})`
            : `Falló (Máx encontrado: ${maxConsecutiveWorkOverall} por ${maxConsecutiveWorkEmployee || 'N/A'})`,
    });
     results.push({
        rule: `Prioridad 5 - Máx Días 'D' Consecutivos (General)`,
        passed: prio5DPassedOverall,
        details: prio5DPassedOverall
            ? `Pasó (Máx encontrado: ${maxConsecutiveDOverall})`
            : `Falló (Máx encontrado: ${maxConsecutiveDOverall} por ${maxConsecutiveDEmployee || 'N/A'})`,
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
                        t_m_details.push(`${emp.name} en ${format(parseISO(currentDayDateStr), 'dd/MM')}`);
                     }
                 }
              } catch (e) { /* Ignore date parsing errors for robust validation */ }
         }
     })
      results.push({
        rule: `Flexible 1 - Descanso T->M 12h`,
        passed: t_m_violations === 0,
        details: t_m_violations === 0 ? 'No se detectaron violaciones' : `Violaciones Potenciales: ${t_m_violations} instancia(s) (${t_m_details.slice(0, 3).join(', ')}${t_m_violations > 3 ? '...' : ''})`,
    });

    // Flexible Rule 4: Target staffing levels
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
          rule: `Flexible 4 - Dotación Objetivo (General)`,
          passed: true,
          details: staffingDeviations === 0 ? 'Todos los días cumplieron dotación objetivo.' : `${staffingDeviations} día(s) se desviaron de la dotación objetivo (Obj Día Lab: ${TARGET_M_WORKDAY}M/${TARGET_T}T, Finde/Fer: ${TARGET_M_WEEKEND_HOLIDAY}M/${TARGET_T}T).`,
      });

    // Flexible Rule 5: M/T balance for employees
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
           rule: `Flexible 5 - Balance M/T (General)`,
           passed: true,
           details: balanceIssues === 0 ? 'Conteos M/T de empleados parecen balanceados.' : `${balanceIssues} empleado(s) muestran desbalance M/T potencial (dif > 3).`,
       });


    employees.forEach(emp => {
        if (emp.preferences?.preferWeekendWork) {
            const prefs = emp.preferences;
            let violations: string[] = [];
            schedule.days.forEach(day => {
                try {
                     const shift = day.shifts[emp.id];
                     if (!shift) return;

                     const date = parseISO(day.date);
                     if (!isValid(date)) return;

                     if (prefs.preferWeekendWork && (shift === 'D' || shift === 'F') && day.isWeekend) violations.push(`Franco/Libre en finde de trabajo preferido ${format(date, 'dd/MM')}`);
                } catch (e) { /* Ignore date parsing issues */ }
            })
             if (violations.length > 0) {
                results.push({
                    rule: `Preferencia Flexible - ${emp.name}`,
                    passed: true,
                    details: `Desajustes de Preferencia: ${violations.slice(0,2).join(', ')}${violations.length > 2 ? '...' : ''}`
                });
            }
        }
    });


    let unassignedCount = 0;
    let unassignedDetails: string[] = [];
    schedule.days.forEach(day => {
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                const isOnLeaveFullMonth = absences.some(a =>
                    a.employeeId === emp.id &&
                    a.startDate && a.endDate &&
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


     results.sort((a, b) => {
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

  return results;
}


function iterativeAssignShifts(schedule: Schedule, employees: Employee[], absences: Absence[], holidays: Holiday[]) {
    const baseWeekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);

    // --- Pass 1: Ensure Essential Coverage (M/T) ---
    console.log("Pase 1: Cobertura Esencial (M/T)");
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
                .sort((a, b) => (schedule.employeeTotals[a.id]?.workedDays || 0) - (schedule.employeeTotals[b.id]?.workedDays || 0));

            if (candidates.length > 0) {
                assignShift(candidates[0].id, dateStr, shiftType, schedule);
                 if (day.shifts[candidates[0].id] === shiftType) {
                    assignedInDay[shiftType]++;
                    availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
                    return true;
                }
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
            console.warn(`No se pudo cumplir TPT >= ${MIN_COVERAGE_TPT} en ${dateStr}. M actual=${assignedInDay.M}, T=${assignedInDay.T}`);
            break;
        }

        if (assignedInDay.M + assignedInDay.T > MIN_COVERAGE_TPT && !day.isWeekend && !day.isHoliday) {
            while (assignedInDay.M <= assignedInDay.T) {
                if (!assignShiftIfPossible('M')) {
                     console.warn(`No se pudo aplicar regla M > T en ${dateStr}. No hay más turnos M disponibles.`);
                    break;
                }
            }
        }
    });
    calculateFinalTotals(schedule, employees, absences);

    // --- Pass 2: Aim for Target Staffing Levels ---
    console.log("Pase 2: Dotación Preferida/Objetivo");
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
                 .sort((a,b) => (schedule.employeeTotals[a.id]?.M || 0) - (schedule.employeeTotals[b.id]?.M || 0));
             if (candidates.length === 0) break;
             assignShift(candidates[0].id, dateStr, 'M', schedule);
              if (day.shifts[candidates[0].id] === 'M') {
                currentM++;
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
              } else {
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
              }
         }

         while (currentT < targetT) {
             const candidates = availableEmployees
                 .filter(e => canWorkShift(e, dateStr, 'T', schedule, employees))
                 .sort((a,b) => (schedule.employeeTotals[a.id]?.T || 0) - (schedule.employeeTotals[b.id]?.T || 0));
             if (candidates.length === 0) break;
             assignShift(candidates[0].id, dateStr, 'T', schedule);
             if (day.shifts[candidates[0].id] === 'T') {
                currentT++;
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
             } else {
                availableEmployees = availableEmployees.filter(e => e.id !== candidates[0].id);
             }
         }
    });
    calculateFinalTotals(schedule, employees, absences);

    // --- Pass 3: Assign Rest Days (D, F), aiming for proportional D target ---
    console.log("Pase 3: Asignar Descansos (D, F) apuntando a D objetivo proporcional");
    const employeeDTargets: { [empId: number]: number } = {};
    employees.forEach(emp => {
        employeeDTargets[emp.id] = calculateEmployeeDTarget(emp, schedule, absences, baseWeekendDaysInMonth);
    });


    schedule.days.forEach(day => {
         const dateStr = day.date;
         const employeesSortedForRest = [...employees].sort((a, b) => {
             const needsDA = (schedule.employeeTotals[a.id]?.D || 0) < employeeDTargets[a.id];
             const needsDB = (schedule.employeeTotals[b.id]?.D || 0) < employeeDTargets[b.id];

             if (needsDA && !needsDB) return -1;
             if (!needsDA && needsDB) return 1;

             return (schedule.employeeTotals[a.id]?.D || 0) - (schedule.employeeTotals[b.id]?.D || 0);
         });


         employeesSortedForRest.forEach(emp => {
             if (day.shifts[emp.id] === null) {
                const isOnLeaveFullMonth = absences.some(absenceRecord => {
                    if(absenceRecord.employeeId !== emp.id || !absenceRecord.startDate || !absenceRecord.endDate) return false;
                    try {
                        const absenceStart = parseISO(absenceRecord.startDate);
                        const absenceEnd = parseISO(absenceRecord.endDate);
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
                 }
                 else if ((schedule.employeeTotals[emp.id]?.D || 0) < employeeDTargets[emp.id] && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                      assignShift(emp.id, dateStr, 'D', schedule);
                 }
                 else if (!day.isHoliday && canWorkShift(emp, dateStr, 'D', schedule, employees)) { // Assign D if other conditions not met
                    assignShift(emp.id, dateStr, 'D', schedule);
                 }
                  else {
                      console.warn(`No se pudo asignar turno de descanso (D/F) a ${emp.name} en ${dateStr}. Ranura vacía.`);
                 }
                 calculateFinalTotals(schedule, employees, absences); // Recalculate for next employee decision
             }
         });
     });
    calculateFinalTotals(schedule, employees, absences);

    // Pass 3.5: Fill remaining nulls
    console.log("Pase 3.5: Llenar NULOS restantes con D o F");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                const isOnLeaveFullMonth = absences.some(a => {
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
                    if (canWorkShift(emp, dateStr, 'F', schedule, employees)) assignShift(emp.id, dateStr, 'F', schedule);
                } else if ((schedule.employeeTotals[emp.id]?.D || 0) < employeeDTargets[emp.id] && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                    assignShift(emp.id, dateStr, 'D', schedule);
                } else if (canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                     assignShift(emp.id, dateStr, 'D', schedule);
                }
                 else {
                    console.warn(`Pase 3.5: Aún no se puede asignar D/F a ${emp.name} en ${dateStr}`);
                }
                calculateFinalTotals(schedule, employees, absences); // Recalculate after each assignment in this critical pass
            }
        });
    });
    calculateFinalTotals(schedule, employees, absences);
}


export function generateSchedule(
  year: number,
  month: number,
  initialEmployees: Employee[],
  initialAbsences: Absence[],
  initialHolidays: Holiday[]
): { schedule: Schedule; report: ValidationResult[] } {

  console.log("Iniciando Generación de Horario para", { year, month });
  const employeesForGeneration: Employee[] = JSON.parse(JSON.stringify(initialEmployees));
  const absencesForGeneration: Absence[] = JSON.parse(JSON.stringify(initialAbsences));
  const holidaysForGeneration: Holiday[] = JSON.parse(JSON.stringify(initialHolidays));

  currentEmployeesState = employeesForGeneration;

  const startTime = performance.now();
  const schedule = initializeSchedule(year, month, employeesForGeneration, holidaysForGeneration);
  console.log("Estructura de horario inicializada.");

  console.log("Aplicando ausencias...");
  applyAbsences(schedule, absencesForGeneration, employeesForGeneration);
  console.log("Aplicando asignaciones/preferencias fijas...");
  applyFixedAssignments(schedule, employeesForGeneration);

  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration);


  console.log("Iniciando pases de asignación iterativa...");
  // Run iterative assignment multiple times if needed for better distribution, though current logic is designed for one pass.
  // For more complex scenarios, a loop with convergence checks or different strategies per iteration might be used.
  iterativeAssignShifts(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration);
  console.log("Pases de asignación iterativa finalizados.");

  console.log("Calculando totales finales...");
  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration);

  console.log("Validando horario final...");
  const report = validateSchedule(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration);
  const endTime = performance.now();
  console.log(`Generación de horario completada en ${(endTime - startTime).toFixed(2)} ms`);

   report.push({ rule: "Info Generador", passed: true, details: `Generación tomó ${(endTime - startTime).toFixed(2)} ms` });

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
