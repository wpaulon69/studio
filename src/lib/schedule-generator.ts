

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
import { es } from 'date-fns/locale'; // Import Spanish locale

// --- Constants and Configuration ---
const MAX_CONSECUTIVE_WORK_DAYS = 6;
const MAX_CONSECUTIVE_NON_WORK_DAYS = 2; // Combined limit for D or F
const REQUIRED_DD_WEEKENDS = 1;
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
        acc[emp.id] = null;
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
             console.warn(`Formato de fecha inválido en ausencia para empleado ${employee.name}: ${absence.startDate} - ${absence.endDate}`);
             return;
        }

        schedule.days.forEach(day => {
          const currentDate = parseISO(day.date);
          if (currentDate >= startDate && currentDate <= endDate) {
                 day.shifts[absence.employeeId] = absence.type;
          }
        });
    } catch (e) {
         console.error(`Error procesando ausencia para empleado ${employee.name}:`, e);
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
                    console.warn(`Omitiendo asignación fija con fecha inválida para ${employee.name}: ${assignment.date}`)
                 }
            });
        }

         if (prefs.fixedWorkShift) {
            const { dayOfWeek: daysOfWeek, shift } = prefs.fixedWorkShift;
            if(Array.isArray(daysOfWeek) && shift) {
                schedule.days.forEach(day => {
                     if (day.shifts[employee.id] === null) { // Only apply if not already set (e.g. by LAO/LM or specific fixedAssignment)
                         const currentDate = parseISO(day.date);
                         const currentDayOfWeek = getDay(currentDate); // 0 for Sunday, 1 for Monday, etc.
                         if (daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday) {
                             day.shifts[employee.id] = shift;
                         }
                     }
                })
            }
         }
    });
}


function getConsecutiveDaysOfTypeBefore(
    employeeId: number,
    dateStr: string,
    schedule: Schedule,
    employees: Employee[],
    targetTypes: Array<'work' | 'nonWork' | ShiftType>
): number {
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

    const scheduleStartDateString = schedule.days[0]?.date;
    if (!scheduleStartDateString) return 0; // No days in schedule
    const scheduleStartDate = parseISO(scheduleStartDateString);


    const isTargetType = (shift: ShiftType | null): boolean => {
        if (shift === null) return false;
        if (targetTypes.includes('work') && (shift === 'M' || shift === 'T')) return true;
        if (targetTypes.includes('nonWork') && (shift === 'D' || shift === 'F')) return true; // F also counts as nonWork
        return targetTypes.includes(shift);
    };

    // Check within current schedule
    while (isValid(currentDate) && currentDate >= scheduleStartDate) {
        const currentDayStr = format(currentDate, 'yyyy-MM-dd');
        const daySchedule = schedule.days.find(d => d.date === currentDayStr);
        const shift = daySchedule?.shifts[employeeId];

        if (isTargetType(shift)) {
            consecutiveDays++;
        } else {
            return consecutiveDays; // Streak broken
        }
        currentDate = subDays(currentDate, 1);
    }

    // Check history if streak continues before schedule start
    const history = employee.history || {};
    const historyDates = Object.keys(history).sort((a,b) => parseISO(b).getTime() - parseISO(a).getTime()); // Ensure reverse chronological

    for (const histDateStr of historyDates) {
        if (format(currentDate, 'yyyy-MM-dd') !== histDateStr) { // If history is not contiguous with schedule start
            return consecutiveDays;
        }
        try {
            const histDate = parseISO(histDateStr);
            if (!isValid(histDate)) continue;

            const shift = history[histDateStr];
            if (isTargetType(shift)) {
                consecutiveDays++;
            } else {
                return consecutiveDays;
            }
            currentDate = subDays(currentDate, 1);
        } catch (e) {
            console.warn(`Error parseando fecha de historial ${histDateStr} para empleado ${employee.name}. Omitiendo.`);
            return consecutiveDays; // Safety break
        }
    }
    return consecutiveDays;
}

function canWorkShift(
    employee: Employee,
    dateStr: string,
    shift: ShiftType | null,
    schedule: Schedule,
    employees: Employee[],
    relaxedMode: boolean = false // Added relaxedMode
): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    if (!day) return false;

    if (shift === null) return true; // Can always assign null to clear a shift (if not LAO/LM)

    // Critical: LAO/LM are non-negotiable unless we are trying to assign the *same* LAO/LM shift
    const existingShift = day.shifts[employee.id];
    if ((existingShift === 'LAO' || existingShift === 'LM') && existingShift !== shift) {
        return false;
    }

    // If not in relaxed mode, apply standard work constraints for M/T shifts
    if (!relaxedMode) {
        if ((shift === 'M' || shift === 'T')) {
            const consecutiveWorkBefore = getConsecutiveDaysOfTypeBefore(employee.id, dateStr, schedule, employees, ['work']);
            if (consecutiveWorkBefore >= MAX_CONSECUTIVE_WORK_DAYS) {
                return false;
            }
        }
        if (shift === 'M') {
            // Check for T on the previous day
            const prevDate = subDays(parseISO(dateStr), 1);
            const prevDateStr = format(prevDate, 'yyyy-MM-dd');
            const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
            let prevShift: ShiftType | null = null;

            if (prevDaySchedule) {
                prevShift = prevDaySchedule.shifts[employee.id];
            } else { // Check history if previous day is outside current schedule
                prevShift = employee.history?.[prevDateStr] || null;
            }
            if (prevShift === 'T') return false; // Cannot work M after T (12h rest rule)
        }
    }

    // These rules apply regardless of relaxedMode for non-work shifts (D/F)
    if (shift === 'D' || shift === 'F') {
        const consecutiveNonWorkBefore = getConsecutiveDaysOfTypeBefore(employee.id, dateStr, schedule, employees, ['nonWork']);
        if (consecutiveNonWorkBefore >= MAX_CONSECUTIVE_NON_WORK_DAYS) { // D or F combined
            return false;
        }
    }

    if (shift === 'D' && day.isHoliday) { // 'D' cannot be on a holiday, 'F' should be used for rest on holiday
        return false;
    }

    const prefs = employee.preferences || {};
    // Check fixed assignments (these are strong, should generally be respected even in relaxed mode if they are D/F)
    if (prefs.fixedAssignments?.some(a => {
        if (a.date === dateStr) {
            // If fixed assignment is LAO/LM, it's already handled by the check above.
            // If fixed assignment is D/F, and we're trying to assign M/T, this is a conflict.
            if ((a.shift === 'D' || a.shift === 'F') && (shift === 'M' || shift === 'T')) {
                return true; // Block assigning M/T if fixed to D/F
            }
            // If fixed assignment is a specific work shift (M/T/D), and we're trying to assign something *else*.
            if (a.shift !== shift) {
                // If trying to assign a work shift (M/T) and it conflicts with a fixed work/day-off (M/T/D)
                if((shift === 'M' || shift === 'T') && ['M','T','D'].includes(a.shift) ){
                    return true;
                }
                // If trying to assign D and it conflicts with fixed M/T
                if(shift === 'D' && (a.shift === 'M' || a.shift === 'T')){
                    return true;
                }
            }
        }
        return false;
    })) {
        if (existingShift !== 'LAO' && existingShift !== 'LM') { // Don't block if already on leave
             return false;
        }
    }


    // Check fixed weekly work shift (e.g., Alamo)
    if (prefs.fixedWorkShift) {
        const { dayOfWeek: daysOfWeek, shift: fixedShiftValue } = prefs.fixedWorkShift; // fixedShiftValue can be 'M', 'T', or 'D'
        if (Array.isArray(daysOfWeek) && fixedShiftValue) {
            const currentDayOfWeek = getDay(parseISO(dateStr)); // 0 for Sunday, 1 for Monday, etc.
            const requiresFixedShiftThisDay = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

            if (requiresFixedShiftThisDay) {
                // If this day requires a fixed shift (e.g., Alamo M on Mon)
                // AND the shift we are trying to assign (param 'shift') is DIFFERENT from the fixed one.
                if (shift !== fixedShiftValue) {
                    // If already on LAO/LM, this check is irrelevant for assignment blocking.
                    if (existingShift !== 'LAO' && existingShift !== 'LM') {
                        // Trying to assign a shift (M, T, D, F) that conflicts with a fixed weekly M, T, or D.
                        // This should generally be blocked, even in relaxed mode for coverage,
                        // as fixed weekly shifts are strong preferences.
                        return false;
                    }
                }
            } else {
                // This is NOT a day the fixed weekly shift applies.
                // Example: Alamo works M-F. On Sat/Sun, this 'else' block is hit.
                // If Alamo is 'eligibleWeekend: false' (meaning they generally DON'T work weekends)
                // AND we are trying to assign them M or T on this non-fixed day (weekend/holiday for them)
                // This should typically be blocked for employees like Alamo.
                if (employee.eligibleWeekend === false && (shift === 'M' || shift === 'T')) {
                     // Check if it's a weekend day or a holiday they are not scheduled for their fixed shift
                     if (day.isWeekend || day.isHoliday) {
                        if (existingShift !== 'LAO' && existingShift !== 'LM') {
                            // This employee (e.g., Alamo) shouldn't work M/T on weekends/holidays
                            // unless their fixedWorkShift specifically covered it (which it doesn't if we are in this 'else').
                            return false;
                        }
                     }
                }
            }
        }
    }
    return true;
}

function assignShift(employeeId: number, dateStr: string, shift: ShiftType | null, schedule: Schedule, relaxedMode: boolean = false) {
  const day = schedule.days.find(d => d.date === dateStr);
  if (!day) return;

  const currentShift = day.shifts[employeeId];

  // Allow assignment if slot is null, or if we are clearing a non-LAO/LM shift,
  // or if we are overwriting a non-LAO/LM shift.
  // LAO/LM can only be "assigned" if it matches an existing LAO/LM (effectively a no-op check) or if clearing it (shift=null).
  if (currentShift === null || shift === null || (currentShift !== 'LAO' && currentShift !== 'LM')) {
      const employee = currentEmployeesState.find(e => e.id === employeeId); // currentEmployeesState is module-level
      if (employee && canWorkShift(employee, dateStr, shift, schedule, currentEmployeesState, relaxedMode)) {
           day.shifts[employeeId] = shift;
      }
  } else if(currentShift === 'LAO' || currentShift === 'LM') {
       // If current is LAO/LM, only allow "re-assigning" the same LAO/LM type, or clearing it (shift === null)
       // if canWorkShift allows clearing it (which it does if shift is null and not LAO/LM currently).
       // Essentially, LAO/LM cannot be directly overwritten by M, T, D, F.
       if(shift !== currentShift && shift !== null) {
           // console.warn(`Asignación bloqueada: No se puede sobreescribir ${currentShift} con ${shift} para empleado ${employeeId} en ${dateStr}.`);
       } else if (shift === null) { // Attempting to clear LAO/LM
            // This case should ideally not happen if LAO/LM are from applyAbsences
            // and manual edit is the only way to clear them.
            // For algorithmic assignment, we don't clear pre-set LAO/LM.
            // However, if manual edit needs to clear, canWorkShift(..., null, ...) would be called.
           // console.warn(`Intento de borrar ${currentShift} para ${employeeId} en ${dateStr}. Esto usualmente no se hace algorítmicamente.`);
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

                const overlapStart = absenceStart > monthStartDate ? absenceStart : monthStartDate;
                const overlapEnd = absenceEnd < monthEndDate ? absenceEnd : monthEndDate;

                if (overlapStart <= overlapEnd) {
                    absenceDaysForEmployeeInMonth += differenceInDays(overlapEnd, overlapStart) + 1;
                }
            } catch (e) {
                 console.warn(`Error calculando días de ausencia para objetivo D: ${e}`);
            }
        }
    });

    const workableDays = Math.max(0, totalDaysInCurrentMonth - absenceDaysForEmployeeInMonth);
    if (totalDaysInCurrentMonth === 0 || workableDays === 0) return 0;

    // Calculate D target based on the proportion of the month the employee is available,
    // scaled by the number of weekend days (typical rest days) in a full month.
    const dTarget = Math.round((workableDays / totalDaysInCurrentMonth) * baseWeekendDaysInMonth);
    return Math.max(0, dTarget);
}


export function calculateFinalTotals(schedule: Schedule, employees: Employee[], absencesForTotals?: Absence[]) {
  // Reset daily totals
  schedule.days.forEach(day => {
    day.totals = { M: 0, T: 0, D: 0, F: 0, LM: 0, LAO: 0, TPT: 0 };
  });
  // Reset employee totals
   employees.forEach(emp => {
        if (!schedule.employeeTotals[emp.id]) {
             schedule.employeeTotals[emp.id] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0 };
        } else {
             // Efficiently reset all properties to 0
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
        if (!isValid(date)) throw new Error('Fecha inválida para totales');
    } catch (e) {
        console.error(`Error parseando fecha para cálculo de totales: ${day.date}`);
        return; // Skip this day if date is invalid
    }

    const dayOfWeek = getDay(date); // 0 for Sunday, 6 for Saturday

    Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
        const empId = parseInt(empIdStr);
        const empTotals = schedule.employeeTotals[empId];
        if (!empTotals) {
            // This should not happen if initialized correctly
            console.warn(`Totales de empleado no encontrados para ID ${empId} durante cálculo final.`);
            schedule.employeeTotals[empId] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0 };
            // return; // Continue with the newly initialized totals
        }
         const currentEmpTotals = schedule.employeeTotals[empId]; // Use the (potentially newly initialized) totals

        if (shift === 'M') { day.totals.M++; currentEmpTotals.M++; currentEmpTotals.workedDays++; }
        else if (shift === 'T') { day.totals.T++; currentEmpTotals.T++; currentEmpTotals.workedDays++; }
        else if (shift === 'D') { day.totals.D++; currentEmpTotals.D++; }
        else if (shift === 'F') { day.totals.F++; currentEmpTotals.F++; }
        else if (shift === 'LM') { day.totals.LM++; currentEmpTotals.LM++; }
        else if (shift === 'LAO') { day.totals.LAO++; currentEmpTotals.LAO++; }

        // Calculate free Saturdays/Sundays (if not M or T)
         if (dayOfWeek === 6 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSaturdays++;
         if (dayOfWeek === 0 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSundays++;

    });
    // Calculate TPT for the day
     day.totals.TPT = day.totals.M + day.totals.T;
  });

    // Validate total days assigned per employee
    employees.forEach(emp => {
         const totals = schedule.employeeTotals[emp.id];
         if (!totals) {
             console.warn(`Faltan totales para empleado ${emp.name} (${emp.id}) durante verificación final.`);
             return;
         }
         // Sum of all assigned shift types (worked or non-worked)
         const totalAssignedShiftsOrAbsences = totals.workedDays + totals.D + totals.F + totals.LM + totals.LAO;

         if(totalAssignedShiftsOrAbsences !== numDaysInMonth){
             // Check if the employee is on leave for the entire month
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

             if (!isOnLeaveFullMonth) { // Log error only if not on full month leave
                console.warn(`ALERTA: Empleado ${emp.name} (${emp.id}) desajuste de días totales. Asignados: ${totalAssignedShiftsOrAbsences}, Días del Mes: ${numDaysInMonth}`);
             }
         }
    });
}


export function validateSchedule(schedule: Schedule, employees: Employee[], absences: Absence[], holidays: Holiday[], reportAccumulator?: ValidationResult[]): ValidationResult[] {
  const results: ValidationResult[] = reportAccumulator || []; // Use accumulator if provided
  const employeeMap = new Map(employees.map(e => [e.id, e]));
  const baseWeekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);


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
                           rule: `Prioridad 1 - Conflicto de Ausencia (${employee.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`,
                           passed: false,
                           details: `Falló: Esperado ${absence.type} (ausencia definida), encontrado ${day.shifts[absence.employeeId] ?? 'NULO'}`,
                       });
                       prio1Passed = false;
                   }
               }
           });
        } catch (e) { /* ignore date parsing errors, already warned during application */ }
   });
    employees.forEach(emp => {
        emp.preferences?.fixedAssignments?.forEach(fixed => {
            const day = schedule.days.find(d => d.date === fixed.date);
            if (day && day.shifts[emp.id] !== fixed.shift && day.shifts[emp.id] !== 'LAO' && day.shifts[emp.id] !== 'LM') {
                 results.push({
                    rule: `Prioridad 1 - Conflicto de Asignación Fija (${emp.name} en ${format(parseISO(fixed.date), 'dd/MM', { locale: es })})`,
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
                              rule: `Prioridad 1 - Conflicto Turno Semanal Fijo (${emp.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`,
                              passed: false,
                              details: `Falló: Esperado ${fixedShift} (preferencia), encontrado ${actualShift ?? 'NULO'}`,
                           });
                           prio1Passed = false;
                        }
                         // Check if an employee like Alamo (eligibleWeekend=false) is working M/T on a weekend/holiday
                         // when their fixedWorkShift does not cover that day.
                         if(!requiresFixedShift && emp.eligibleWeekend === false && (actualShift === 'M' || actualShift === 'T')){
                            if(day.isWeekend || day.isHoliday){
                                results.push({
                                    rule: `Prioridad 1 - Conflicto Turno Semanal Fijo (${emp.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`,
                                    passed: false,
                                    details: `Falló: ${emp.name} (no elegible para finde/feriado general) tiene ${actualShift} en día no cubierto por su turno fijo.`,
                                });
                                prio1Passed = false;
                            }
                         }
                  })
              }
          }
    });

   if (prio1Passed && !results.some(r => r.rule.startsWith('Prioridad 1') && !r.passed)) {
       results.push({ rule: `Prioridad 1 - Ausencias/Asignaciones Fijas (General)`, passed: true, details: 'Todas las ausencias y asignaciones fijas respetadas.'});
   }


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
     if (TPT > MIN_COVERAGE_TPT && !day.isHoliday && !day.isWeekend && M <= T) { // M must be > T if TPT > 2 on workdays
         dayPassed = false;
         details.push(`M<=T (M=${M},T=${T}) en día laboral con TPT>${MIN_COVERAGE_TPT}`);
     }

     if(!dayPassed) {
         results.push({
           rule: `Prioridad 2 - Cobertura Mínima/Ratio M-T (${format(parseISO(day.date), 'dd/MM', { locale: es })})`,
           passed: false,
           details: `Falló: ${details.join(', ')}`,
         });
         prio2Passed = false;
     }
   });
   if (prio2Passed && !results.some(r => r.rule.startsWith('Prioridad 2 Alerta Grave') && !r.passed) && !results.some(r => r.rule.startsWith('Prioridad 2 - Cobertura Mínima/Ratio M-T (') && !r.passed)) {
        results.push({ rule: `Prioridad 2 - Cobertura Mínima/Ratio M-T (General)`, passed: true, details: 'Cobertura mínima y ratio M-T en días laborales cumplidos.'});
    }


   let prio3Passed = true;
   employees.forEach(emp => {
       const targetDs = calculateEmployeeDTarget(emp, schedule, absences, baseWeekendDaysInMonth);
       if (schedule.employeeTotals[emp.id]) {
           const actualDs = schedule.employeeTotals[emp.id].D ?? 0;
           if (actualDs !== targetDs) {
               results.push({
                   rule: `Prioridad 3 - Cantidad 'D' Objetivo (${emp.name})`,
                   passed: false,
                   details: `Falló: Tiene ${actualDs} 'D', requiere ${targetDs} (proporcional a días trabajables).`,
               });
               prio3Passed = false;
           }
       } else {
           console.warn(`Totales no encontrados para ${emp.name} durante validación Prio 3 D.`);
           results.push({
               rule: `Prioridad 3 - Cantidad 'D' Objetivo (${emp.name})`,
               passed: false,
               details: `Falló: Faltan totales para calcular, requiere ${targetDs}.`,
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
                         rule: `Prioridad 3 - 'D' en Feriado (${employee?.name || `Emp ${empIdStr}`} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`,
                         passed: false,
                         details: `Falló: ${employee?.name || `Emp ${empIdStr}`} tiene 'D' en feriado ${format(parseISO(day.date), 'dd/MM/yyyy', { locale: es })}. Debe ser 'F' si descansa.`,
                     });
                     prio3Passed = false;
                 }
            })
        }
    });
     if (prio3Passed && !results.some(r => r.rule.startsWith('Prioridad 3') && !r.passed)) {
       results.push({ rule: `Prioridad 3 - Descansos 'D' y Feriados (General)`, passed: true, details: `Cantidad de 'D' proporcional y no hay 'D' en feriados.`});
     }


  let prio4Passed = true;
  let eligibleEmployeesExist = false;
  employees.forEach(emp => {
    if (!emp.eligibleWeekend) return; // Skip if not eligible for D/D weekend
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
         if (getDay(date1) === 6 && getDay(date2) === 0) { // 6 = Saturday, 0 = Sunday
           // A D/D weekend counts if it's D-D, or F-F if both days are holidays,
           // or D-F if Sat is normal and Sun is holiday, or F-D if Sat is holiday and Sun is normal.
           const shift1 = day1.shifts[emp.id];
           const shift2 = day2.shifts[emp.id];
           const isRestDay1 = shift1 === 'D' || (day1.isHoliday && shift1 === 'F');
           const isRestDay2 = shift2 === 'D' || (day2.isHoliday && shift2 === 'F');

           if (isRestDay1 && isRestDay2) {
             ddWeekends++;
           }
         }
      } catch(e){ console.warn("Error parseando fecha en validación Prio 4", e); continue; }
    }
     if (ddWeekends < REQUIRED_DD_WEEKENDS) {
         results.push({
           rule: `Prioridad 4 - Fin de Semana D/D (o F/F en Feriado) (${emp.name})`,
           passed: false,
           details: `Falló: Tiene ${ddWeekends} fin(es) de semana D/D (o F/F si feriado), requiere ${REQUIRED_DD_WEEKENDS}.`,
         });
         prio4Passed = false;
     }
  });
    if (prio4Passed && eligibleEmployeesExist && !results.some(r => r.rule.startsWith('Prioridad 4') && !r.passed)) {
       results.push({ rule: `Prioridad 4 - Fin de Semana D/D (o F/F en Feriado) (General)`, passed: true, details: 'Todos los empleados elegibles tienen su fin de semana D/D (o F/F).'});
   } else if (!eligibleEmployeesExist) {
        results.push({ rule: `Prioridad 4 - Fin de Semana D/D (o F/F en Feriado) (General)`, passed: true, details: 'N/A (No hay empleados elegibles para fin de semana D/D).'});
   }


   let maxConsecutiveWorkOverall = 0;
   let maxConsecutiveWorkEmployee = '';
   let prio5WorkPassedOverall = true;

   let maxConsecutiveNonWorkOverall = 0;
   let maxConsecutiveNonWorkEmployee = '';
   let prio5NonWorkPassedOverall = true;


   employees.forEach(emp => {
       let currentConsecutiveWork = 0;
       let maxForEmployeeWork = 0;
       let currentConsecutiveNonWork = 0;
       let maxForEmployeeNonWork = 0;

       const firstDayStr = schedule.days[0]?.date;
       if(firstDayStr){
            currentConsecutiveWork = getConsecutiveDaysOfTypeBefore(emp.id, firstDayStr, schedule, employees, ['work']);
            maxForEmployeeWork = currentConsecutiveWork;
            currentConsecutiveNonWork = getConsecutiveDaysOfTypeBefore(emp.id, firstDayStr, schedule, employees, ['nonWork']);
            maxForEmployeeNonWork = currentConsecutiveNonWork;
       } else {
            console.warn("Horario no tiene días, no se puede calcular días consecutivos.")
            return;
       }

       schedule.days.forEach(day => {
           const shift = day.shifts[emp.id];
           if (shift === 'M' || shift === 'T') {
               currentConsecutiveWork++;
               maxForEmployeeNonWork = Math.max(maxForEmployeeNonWork, currentConsecutiveNonWork);
               currentConsecutiveNonWork = 0;
           } else if (shift === 'D' || shift === 'F') {
               currentConsecutiveNonWork++;
               maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
               currentConsecutiveWork = 0;
           } else { // LAO, LM, or null (should not be null at this stage ideally)
                maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
                currentConsecutiveWork = 0;
                maxForEmployeeNonWork = Math.max(maxForEmployeeNonWork, currentConsecutiveNonWork);
                currentConsecutiveNonWork = 0;
           }
       });
        maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork); // Final check for sequence at end of month
        maxForEmployeeNonWork = Math.max(maxForEmployeeNonWork, currentConsecutiveNonWork); // Final check

         if(maxForEmployeeWork > maxConsecutiveWorkOverall){
             maxConsecutiveWorkOverall = maxForEmployeeWork;
             maxConsecutiveWorkEmployee = emp.name;
         }
         if (maxForEmployeeWork > MAX_CONSECUTIVE_WORK_DAYS) {
             const empTotals = schedule.employeeTotals[emp.id];
             // Only flag if they actually worked, to avoid flagging those on full month leave etc.
             if(empTotals && (empTotals.workedDays > 0 || empTotals.M > 0 || empTotals.T > 0)) {
                  results.push({
                      rule: `Prioridad 5 - Máx Días Consecutivos de Trabajo (${emp.name})`,
                      passed: false,
                      details: `Falló: Trabajó ${maxForEmployeeWork} días consecutivos (Máx ${MAX_CONSECUTIVE_WORK_DAYS})`,
                  });
                  prio5WorkPassedOverall = false;
              }
         }

         if(maxForEmployeeNonWork > maxConsecutiveNonWorkOverall){
             maxConsecutiveNonWorkOverall = maxForEmployeeNonWork;
             maxConsecutiveNonWorkEmployee = emp.name;
         }
         if (maxForEmployeeNonWork > MAX_CONSECUTIVE_NON_WORK_DAYS) {
              const empTotals = schedule.employeeTotals[emp.id];
              // Only flag if they actually had D or F days.
               if(empTotals && (empTotals.D > 0 || empTotals.F > 0)) {
                    results.push({
                        rule: `Prioridad 5 - Máx Días No Laborables (D/F) Consecutivos (${emp.name})`,
                        passed: false,
                        details: `Falló: Tuvo ${maxForEmployeeNonWork} días no laborables (D/F) consecutivos (Máx ${MAX_CONSECUTIVE_NON_WORK_DAYS})`,
                    });
                    prio5NonWorkPassedOverall = false;
                }
         }
   });
    if (prio5WorkPassedOverall && !results.some(r => r.rule.startsWith('Prioridad 5 - Máx Días Consecutivos de Trabajo (') && !r.passed)) {
         results.push({
            rule: `Prioridad 5 - Máx Días Consecutivos de Trabajo (General)`,
            passed: true,
            details: `Pasó (Máx encontrado: ${maxConsecutiveWorkOverall})`
        });
    }
    if (prio5NonWorkPassedOverall && !results.some(r => r.rule.startsWith('Prioridad 5 - Máx Días No Laborables (D/F) Consecutivos (') && !r.passed)) {
        results.push({
            rule: `Prioridad 5 - Máx Días No Laborables (D/F) Consecutivos (General)`,
            passed: true,
            details: `Pasó (Máx encontrado: ${maxConsecutiveNonWorkOverall})`
        });
    }


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
                      } else { // Check history
                          prevShift = emp.history?.[prevDateStr] || null;
                      }

                     if (prevShift === 'T') {
                        t_m_violations++;
                        if (t_m_details.length < 3) t_m_details.push(`${emp.name} en ${format(parseISO(currentDayDateStr), 'dd/MM', { locale: es })}`);
                     }
                 }
              } catch (e) { /* Ignore date parsing errors for robust validation */ }
         }
     })
      results.push({
        rule: `Flexible 1 - Descanso T->M (12h Estimado)`,
        passed: t_m_violations === 0,
        details: t_m_violations === 0 ? 'No se detectaron secuencias T->M inmediatas.' : `Potenciales Violaciones: ${t_m_violations} instancia(s) (${t_m_details.join(', ')}${t_m_violations > 3 ? '...' : ''})`,
    });

    let compensatoryRestViolations = 0;
    let compensatoryRestDetails: string[] = [];
    schedule.days.forEach((day, dayIndex) => {
        if (day.isHoliday) {
            employees.forEach(emp => {
                const shiftOnHoliday = day.shifts[emp.id];
                if (shiftOnHoliday === 'M' || shiftOnHoliday === 'T') {
                    // Check for subsequent Saturday & Sunday
                    const nextDay1Index = dayIndex + 1;
                    const nextDay2Index = dayIndex + 2;

                    if (nextDay1Index < schedule.days.length && nextDay2Index < schedule.days.length) {
                        const nextDay1 = schedule.days[nextDay1Index];
                        const nextDay2 = schedule.days[nextDay2Index];

                        const dateNextDay1 = parseISO(nextDay1.date);
                        const dateNextDay2 = parseISO(nextDay2.date);

                        // Check if nextDay1 is Saturday and nextDay2 is Sunday
                        if (isValid(dateNextDay1) && getDay(dateNextDay1) === 6 &&
                            isValid(dateNextDay2) && getDay(dateNextDay2) === 0) {
                            
                            let missedCompensatorySat = false;
                            let missedCompensatorySun = false;

                            // Compensatory should be 'D'. 'F' is for a holiday itself.
                            if (nextDay1.shifts[emp.id] !== 'D' && nextDay1.shifts[emp.id] !== 'LAO' && nextDay1.shifts[emp.id] !== 'LM') {
                                missedCompensatorySat = true;
                            }
                            if (nextDay2.shifts[emp.id] !== 'D' && nextDay2.shifts[emp.id] !== 'LAO' && nextDay2.shifts[emp.id] !== 'LM') {
                                missedCompensatorySun = true;
                            }

                            if (missedCompensatorySat || missedCompensatorySun) {
                                compensatoryRestViolations++;
                                if (compensatoryRestDetails.length < 3) {
                                    compensatoryRestDetails.push(`${emp.name} trabajó feriado ${format(parseISO(day.date), 'dd/MM', { locale: es })} y no tuvo D completo el finde sig.`);
                                }
                            }
                        }
                    }
                }
            });
        }
    });
    results.push({
        rule: `Flexible - Descanso Compensatorio Finde Post-Feriado Trabajado`,
        passed: compensatoryRestViolations === 0,
        details: compensatoryRestViolations === 0
            ? 'Se otorgaron descansos compensatorios D en fines de semana post-feriado trabajado donde aplicó.'
            : `${compensatoryRestViolations} instancia(s) de potencial falta de descanso compensatorio D en finde post-feriado trabajado: ${compensatoryRestDetails.join('; ')}${compensatoryRestViolations > 3 ? '...' : ''}`,
    });


    let staffingDeviations = 0;
     schedule.days.forEach(day => {
        const { M, T } = day.totals;
        const isWorkDay = !day.isHoliday && !day.isWeekend;
        const targetM = isWorkDay ? TARGET_M_WORKDAY : TARGET_M_WEEKEND_HOLIDAY;
        const targetT = TARGET_T; // TARGET_T is same for workday/weekend/holiday

         if(M !== targetM || T !== targetT) {
             staffingDeviations++;
         }
     })
      results.push({
          rule: `Flexible 4 - Dotación Objetivo Diaria (General)`,
          passed: true, // This is flexible, so always "passed" from a hard validation POV
          details: staffingDeviations === 0 ? 'Todos los días cumplieron dotación objetivo.' : `${staffingDeviations} día(s) se desviaron de la dotación objetivo (Obj Día Lab: ${TARGET_M_WORKDAY}M/${TARGET_T}T, Finde/Fer: ${TARGET_M_WEEKEND_HOLIDAY}M/${TARGET_T}T).`,
      });

    let balanceIssues = 0;
     employees.forEach(emp => {
         const empTotals = schedule.employeeTotals[emp.id];
         if (!empTotals) return;

         // Exclude employees with fixed weekly shifts from this specific balance check, as their M/T is dictated.
         if(emp.preferences?.fixedWorkShift) return;

         const { M, T } = empTotals;
         const totalShifts = M + T;
         if (totalShifts > 0) { // Only check if they worked M or T at all
             const diff = Math.abs(M - T);
             // Imbalance if difference is more than, say, 20% of total shifts, or an absolute diff of 3-4.
             const imbalanceThreshold = Math.max(3, Math.floor(totalShifts * 0.25)); 
             if (diff > imbalanceThreshold) {
                balanceIssues++;
             }
         }
     });
       results.push({
           rule: `Flexible 5 - Balance Turnos M/T por Empleado (General)`,
           passed: true, // Flexible rule
           details: balanceIssues === 0 ? 'Conteos M/T de empleados (sin turno fijo semanal) parecen balanceados.' : `${balanceIssues} empleado(s) muestran desbalance M/T potencial (diferencia > 3 o 25%).`,
       });


    employees.forEach(emp => {
        if (emp.preferences) {
            const prefs = emp.preferences;
            let violations: string[] = [];
            schedule.days.forEach(day => {
                try {
                     const shift = day.shifts[emp.id];
                     if (!shift) return;

                     const date = parseISO(day.date);
                     if (!isValid(date)) return;

                     if (prefs.preferWeekendWork && (shift === 'D' || shift === 'F') && day.isWeekend) {
                        violations.push(`Franco/Libre en finde de trabajo preferido ${format(date, 'dd/MM', { locale: es })}`);
                     }
                } catch (e) { /* Ignore date parsing issues for robustness */ }
            })
             if (violations.length > 0) {
                results.push({
                    rule: `Preferencia Flexible - ${emp.name}`,
                    passed: true, // Flexible rule
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
                // Check if employee is on leave for the entire month to avoid false positives
                const isOnLeaveFullMonth = absences.some(a => {
                    if (a.employeeId !== emp.id || !a.startDate || !a.endDate) return false;
                    try {
                        const absenceStart = parseISO(a.startDate);
                        const absenceEnd = parseISO(a.endDate);
                        const monthStart = startOfMonth(parseISO(day.date)); // day.date is 'yyyy-MM-dd'
                        const monthEnd = endOfMonth(parseISO(day.date));
                        return isValid(absenceStart) && isValid(absenceEnd) &&
                               absenceStart <= monthStart && absenceEnd >= monthEnd;
                    } catch (e) { return false; }
                });

                if(!isOnLeaveFullMonth){
                   unassignedCount++;
                   if(unassignedDetails.length < 5) unassignedDetails.push(`${emp.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })}`);
                }
            }
        })
    });
     if (unassignedCount > 0) {
        results.push({
            rule: "Verificación de Completitud del Horario",
            passed: false,
            details: `Falló: ${unassignedCount} ranura(s) empleado-día siguen sin asignar (excl. ausencias mes completo). Ej: ${unassignedDetails.join(', ')}${unassignedCount > 5 ? '...' : ''}`,
        });
    } else {
         results.push({
            rule: "Verificación de Completitud del Horario",
            passed: true,
            details: `Pasó: Todas las ranuras empleado-día están asignadas o justificadas por ausencia.`,
        });
    }


     // Sort results: Prioritized rules first, then by pass/fail, then alphabetically
     results.sort((a, b) => {
         const getPrio = (rule: string): number => {
              if (rule.includes("Completitud")) return 0; // Highest priority for visibility
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2 Alerta Grave")) return 1.5; // Grave alerts just below Prio 1
             if (rule.startsWith("Prioridad 2 Info - Asignación Relajada")) return 2.1; // Informational for relaxed
             if (rule.startsWith("Prioridad 2")) return 2;
             if (rule.startsWith("Prioridad 3")) return 3;
             if (rule.startsWith("Prioridad 4")) return 4;
             if (rule.startsWith("Prioridad 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6; // T->M
             if (rule.startsWith("Flexible - Descanso Compensatorio")) return 6.5;
             if (rule.startsWith("Flexible 5")) return 7; // Balance M/T
             if (rule.startsWith("Flexible 4")) return 8; // Dotacion
             if (rule.startsWith("Preferencia Flexible")) return 9;
             if (rule.startsWith("Flexible")) return 10; // Other flexible
             if (rule.startsWith("Info Generador") || rule.startsWith("Prioridad 2 Info")) return 12; // Lowest priority
             return 11; // Default for unrecognized
         }
         const prioA = getPrio(a.rule);
         const prioB = getPrio(b.rule);

         if (prioA !== prioB) return prioA - prioB;
         // Within the same priority, failed rules come first
         if (a.passed !== b.passed) return a.passed ? 1 : -1; // false (failed) comes before true (passed)
         return a.rule.localeCompare(b.rule); // Alphabetical for same priority and status
     });

  return results;
}

// Module-level state for current employees, accessible by assignShift
let currentEmployeesState: Employee[] = [];

function iterativeAssignShifts(schedule: Schedule, employees: Employee[], absences: Absence[], holidays: Holiday[], report: ValidationResult[]) {
    const baseWeekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);
    currentEmployeesState = employees; // Set module-level state

    // Helper to recalculate day totals locally after an assignment within a pass
    const calculateDayTotals = (day: ScheduleDay) => {
        day.totals = { M: 0, T: 0, D: 0, F: 0, LM: 0, LAO: 0, TPT: 0 };
        Object.values(day.shifts).forEach(s => {
            if (s === 'M') day.totals.M++;
            else if (s === 'T') day.totals.T++;
            else if (s === 'D') day.totals.D++;
            else if (s === 'F') day.totals.F++;
            else if (s === 'LM') day.totals.LM++;
            else if (s === 'LAO') day.totals.LAO++;
        });
        day.totals.TPT = day.totals.M + day.totals.T;
    };


    // --- Pass 1: Ensure Essential Coverage (M/T) ---
    console.log("Iteración 1: Cobertura Esencial (M/T)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        calculateDayTotals(day); // Ensure current totals before starting assignments for the day

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null);

        const assignShiftIfPossible = (shiftType: 'M' | 'T', relaxed = false): boolean => {
            const candidates = availableEmployees
                .filter(e => day.shifts[e.id] === null && canWorkShift(e, dateStr, shiftType, schedule, employees, relaxed))
                .sort((a, b) => { // Prioritize employees with fewer total worked days, then fewer of the specific shift
                    const totalsA = schedule.employeeTotals[a.id] || { workedDays: 0, M: 0, T: 0 };
                    const totalsB = schedule.employeeTotals[b.id] || { workedDays: 0, M: 0, T: 0 };
                    if (totalsA.workedDays !== totalsB.workedDays) {
                        return totalsA.workedDays - totalsB.workedDays;
                    }
                    return shiftType === 'M' ? (totalsA.M - totalsB.M) : (totalsA.T - totalsB.T);
                });

            if (candidates.length > 0) {
                const chosenEmployee = candidates[0];
                assignShift(chosenEmployee.id, dateStr, shiftType, schedule, relaxed); // assignShift uses module-level currentEmployeesState
                if (day.shifts[chosenEmployee.id] === shiftType) { // Confirm assignment was successful
                    calculateDayTotals(day); // Recalculate day totals immediately
                    
                    // Rough update of employee totals for sorting within this day's loop. Full calc between passes.
                    if(schedule.employeeTotals[chosenEmployee.id]) {
                        schedule.employeeTotals[chosenEmployee.id].workedDays++;
                        if(shiftType === 'M') schedule.employeeTotals[chosenEmployee.id].M++;
                        if(shiftType === 'T') schedule.employeeTotals[chosenEmployee.id].T++;
                    }

                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id); // Update available list
                    if(relaxed) {
                        console.warn(`Pass 1 (${dateStr}): Asignación RELAJADA de ${shiftType} a ${chosenEmployee.name} (${chosenEmployee.id}) para cobertura.`);
                        if (!report.find(r => r.rule.includes(`Asignación Relajada (${chosenEmployee.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`) && r.details?.includes(shiftType))) {
                            report.push({ rule: `Prioridad 2 Info - Asignación Relajada (${chosenEmployee.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`, passed: true, details: `Se asignó ${shiftType} en modo relajado para cumplir cobertura mínima. Puede violar MAX_CONSECUTIVE_WORK o T->M.` });
                        }
                    }
                    return true;
                }
            }
            return false;
        };

        // Standard attempts to meet M, T, then TPT minimums
        while (day.totals.M < MIN_COVERAGE_M) {
            if (!assignShiftIfPossible('M', false)) break;
        }
        while (day.totals.T < MIN_COVERAGE_T) {
            if (!assignShiftIfPossible('T', false)) break;
        }
        while (day.totals.TPT < MIN_COVERAGE_TPT) {
            if (day.totals.M <= day.totals.T) { // Prioritize M if M is lower or equal
                if (assignShiftIfPossible('M', false)) continue;
                if (assignShiftIfPossible('T', false)) continue;
            } else { // Prioritize T if T is lower
                if (assignShiftIfPossible('T', false)) continue;
                if (assignShiftIfPossible('M', false)) continue;
            }
            break; // Cannot assign more in standard mode
        }

        // If minimums still not met, try with relaxed constraints
        if (day.totals.M < MIN_COVERAGE_M || day.totals.T < MIN_COVERAGE_T || day.totals.TPT < MIN_COVERAGE_TPT) {
            if(day.totals.M < MIN_COVERAGE_M) console.warn(`Pass 1 (${dateStr}): M < ${MIN_COVERAGE_M} (${day.totals.M}). Intentando con restricciones relajadas para M.`);
            if(day.totals.T < MIN_COVERAGE_T) console.warn(`Pass 1 (${dateStr}): T < ${MIN_COVERAGE_T} (${day.totals.T}). Intentando con restricciones relajadas para T.`);
            if(day.totals.TPT < MIN_COVERAGE_TPT && !(day.totals.M < MIN_COVERAGE_M || day.totals.T < MIN_COVERAGE_T) ) console.warn(`Pass 1 (${dateStr}): TPT < ${MIN_COVERAGE_TPT} (${day.totals.TPT}). Intentando con restricciones relajadas para TPT.`);
            
            availableEmployees = employees.filter(e => day.shifts[e.id] === null); // Reset available employees for relaxed pass

            while (day.totals.M < MIN_COVERAGE_M) {
                if (!assignShiftIfPossible('M', true)) break; 
            }
            while (day.totals.T < MIN_COVERAGE_T) {
                if (!assignShiftIfPossible('T', true)) break;
            }
            
            // Simplified loop for TPT in relaxed mode
            while (day.totals.TPT < MIN_COVERAGE_TPT) {
                let assignedInRelaxedTPTIteration = false;
                // Try M first, then T
                if (assignShiftIfPossible('M', true)) {
                    assignedInRelaxedTPTIteration = true;
                } else if (assignShiftIfPossible('T', true)) {
                    assignedInRelaxedTPTIteration = true;
                }

                if (!assignedInRelaxedTPTIteration) {
                    console.error(`Pass 1 (${dateStr}): IMPOSIBLE cumplir TPT >= ${MIN_COVERAGE_TPT} incluso con restricciones relajadas. Actual TPT: ${day.totals.TPT}, M: ${day.totals.M}, T: ${day.totals.T}.`);
                    const ruleKey = `Prioridad 2 Alerta Grave - Cobertura TPT (${format(parseISO(day.date), 'dd/MM', { locale: es })})`;
                    if (!report.some(r => r.rule === ruleKey)) { // Add only if not already reported for this day
                        report.push({ rule: ruleKey, passed: false, details: `Falló: No se pudo alcanzar TPT >= ${MIN_COVERAGE_TPT}. TPT Actual: ${day.totals.TPT}, M: ${day.totals.M}, T: ${day.totals.T}. Posibles causas: empleados no disponibles (LAO/LM) o conflictos con asignaciones/preferencias fijas no flexibles.` });
                    }
                    break; 
                }
            }
        }
         // Ensure M > T if TPT > 2 on workdays (non-holiday, non-weekend)
         calculateDayTotals(day); // Recalculate after all min coverage attempts
         if (day.totals.TPT > MIN_COVERAGE_TPT && !day.isHoliday && !day.isWeekend && day.totals.M <= day.totals.T) {
             console.warn(`Pass 1 (${dateStr}): TPT > ${MIN_COVERAGE_TPT} pero M (${day.totals.M}) <= T (${day.totals.T}). Intentando asignar M adicional.`);
             availableEmployees = employees.filter(e => day.shifts[e.id] === null); // Refresh available
             // Try standard, then relaxed if needed, to make M > T
             if (!assignShiftIfPossible('M', false)) {
                 assignShiftIfPossible('M', true); // Try relaxed if standard fails
             }
         }
    });
    calculateFinalTotals(schedule, employees, absences); // Full recalculation after Pass 1

    // --- Pass 2: Aim for Target Staffing Levels (Flexible) ---
    console.log("Iteración 2: Dotación Objetivo/Preferida");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        calculateDayTotals(day); // Current totals for the day
        
        const targetM = day.isWeekend || day.isHoliday ? TARGET_M_WEEKEND_HOLIDAY : TARGET_M_WORKDAY;
        const targetT = TARGET_T;
        let availableEmployees = employees.filter(e => day.shifts[e.id] === null);

        const assignToTarget = (shiftType: 'M' | 'T', currentCount: number, targetCount: number) => {
            let count = currentCount;
            while (count < targetCount) {
                const candidates = availableEmployees
                    .filter(e => day.shifts[e.id] === null && canWorkShift(e, dateStr, shiftType, schedule, employees, false)) // Standard mode for targets
                    .sort((a,b) => (shiftType === 'M' ? (schedule.employeeTotals[a.id]?.M || 0) - (schedule.employeeTotals[b.id]?.M || 0) 
                                                     : (schedule.employeeTotals[a.id]?.T || 0) - (schedule.employeeTotals[b.id]?.T || 0)));
                if (candidates.length === 0) break;
                const chosenEmployee = candidates[0];
                assignShift(chosenEmployee.id, dateStr, shiftType, schedule, false);
                if (day.shifts[chosenEmployee.id] === shiftType) {
                    count++;
                    calculateDayTotals(day); // Update day totals
                     if(schedule.employeeTotals[chosenEmployee.id]) { // Rough update emp totals
                        schedule.employeeTotals[chosenEmployee.id].workedDays++;
                        if(shiftType === 'M') schedule.employeeTotals[chosenEmployee.id].M++;
                        if(shiftType === 'T') schedule.employeeTotals[chosenEmployee.id].T++;
                    }
                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id);
                } else { // Assignment failed (e.g. canWorkShift returned false unexpectedly after sort)
                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id); // Remove to prevent infinite loop
                }
            }
            return count;
        }
        assignToTarget('M', day.totals.M, targetM);
        assignToTarget('T', day.totals.T, targetT);
    });
    calculateFinalTotals(schedule, employees, absences);

    // --- Pass 2.5: Compensatory Rest after Holiday Work (D on subsequent Sat/Sun) ---
    console.log("Iteración 2.5: Asignar Descanso Compensatorio Post-Feriado");
    schedule.days.forEach((day, dayIndex) => {
        if (day.isHoliday) {
            employees.forEach(emp => {
                const shiftOnHoliday = day.shifts[emp.id];
                if (shiftOnHoliday === 'M' || shiftOnHoliday === 'T') {
                    const nextDay1Index = dayIndex + 1;
                    const nextDay2Index = dayIndex + 2;

                    if (nextDay1Index < schedule.days.length && nextDay2Index < schedule.days.length) {
                        const nextDay1 = schedule.days[nextDay1Index];
                        const nextDay2 = schedule.days[nextDay2Index];
                        const dateNextDay1 = parseISO(nextDay1.date);
                        const dateNextDay2 = parseISO(nextDay2.date);

                        if (isValid(dateNextDay1) && getDay(dateNextDay1) === 6 && // Saturday
                            isValid(dateNextDay2) && getDay(dateNextDay2) === 0) { // Sunday

                            // Assign 'D' on Saturday if possible and not already LAO/LM/Fixed D
                            if (nextDay1.shifts[emp.id] === null || (nextDay1.shifts[emp.id] !== 'LAO' && nextDay1.shifts[emp.id] !== 'LM')) {
                                if (canWorkShift(emp, nextDay1.date, 'D', schedule, employees)) {
                                    assignShift(emp.id, nextDay1.date, 'D', schedule);
                                }
                            }
                            // Assign 'D' on Sunday if possible and not already LAO/LM/Fixed D
                            if (nextDay2.shifts[emp.id] === null || (nextDay2.shifts[emp.id] !== 'LAO' && nextDay2.shifts[emp.id] !== 'LM')) {
                                 if (canWorkShift(emp, nextDay2.date, 'D', schedule, employees)) {
                                    assignShift(emp.id, nextDay2.date, 'D', schedule);
                                }
                            }
                        }
                    }
                }
            });
        }
    });
    calculateFinalTotals(schedule, employees, absences);


    // --- Pass 3: Assign Rest Days (D, F), aiming for proportional D target ---
    console.log("Iteración 3: Asignar Descansos (D, F) apuntando a D objetivo proporcional");
    const employeeDTargets: { [empId: number]: number } = {};
    employees.forEach(emp => {
        employeeDTargets[emp.id] = calculateEmployeeDTarget(emp, schedule, absences, baseWeekendDaysInMonth);
    });

    schedule.days.forEach(day => {
         const dateStr = day.date;
         // Sort employees: those needing 'D' most come first, then those with fewer 'D's overall.
         const employeesSortedForRest = [...employees].sort((a, b) => {
             const aTotals = schedule.employeeTotals[a.id] || { D: 0 };
             const bTotals = schedule.employeeTotals[b.id] || { D: 0 };
             const needsDA = aTotals.D < employeeDTargets[a.id];
             const needsDB = bTotals.D < employeeDTargets[b.id];

             if (needsDA && !needsDB) return -1; // A needs D more urgently
             if (!needsDA && needsDB) return 1;  // B needs D more urgently

             return aTotals.D - bTotals.D; // Then, fewer D's overall
         });

         employeesSortedForRest.forEach(emp => {
             if (day.shifts[emp.id] === null) { // If slot is empty
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
                if (isOnLeaveFullMonth) return; // Skip if on leave for the whole month

                 if (day.isHoliday) { // On a holiday, prioritize 'F' for rest if possible
                     if (canWorkShift(emp, dateStr, 'F', schedule, employees)) {
                        assignShift(emp.id, dateStr, 'F', schedule);
                     } else if (canWorkShift(emp, dateStr, 'D', schedule, employees)) { // Fallback to D if F not possible (e.g., MAX_CONSECUTIVE_NON_WORK)
                        assignShift(emp.id, dateStr, 'D', schedule);
                     }
                 } else { // Not a holiday
                     // Prioritize 'D' if below target or generally
                     if ((schedule.employeeTotals[emp.id]?.D || 0) < employeeDTargets[emp.id] && canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                          assignShift(emp.id, dateStr, 'D', schedule);
                     } else if (canWorkShift(emp, dateStr, 'D', schedule, employees)) { // General D assignment
                        assignShift(emp.id, dateStr, 'D', schedule);
                     } else if (canWorkShift(emp, dateStr, 'F', schedule, employees)) { // Fallback to F if D not possible
                        assignShift(emp.id, dateStr, 'F', schedule);
                     }
                 }
                 if(day.shifts[emp.id] !== null) calculateDayTotals(day); // Recalculate day totals if a shift was assigned
             }
         });
     });
    calculateFinalTotals(schedule, employees, absences);

    // Pass 3.5: Fill remaining nulls robustly with D or F
    console.log("Iteración 3.5: Llenar NULOS restantes con D o F robustamente");
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

                let assignedInFill = false;
                if (day.isHoliday) {
                    if (canWorkShift(emp, dateStr, 'F', schedule, employees)) {
                        assignShift(emp.id, dateStr, 'F', schedule);
                        assignedInFill = day.shifts[emp.id] === 'F';
                    }
                }
                if (!assignedInFill) { // Not a holiday, or F failed on holiday
                    if (canWorkShift(emp, dateStr, 'D', schedule, employees)) {
                        assignShift(emp.id, dateStr, 'D', schedule);
                        assignedInFill = day.shifts[emp.id] === 'D';
                    } else if (canWorkShift(emp, dateStr, 'F', schedule, employees)) { // Try F if D is not possible
                        assignShift(emp.id, dateStr, 'F', schedule);
                        assignedInFill = day.shifts[emp.id] === 'F';
                    }
                }
                 
                if (!assignedInFill) { 
                    console.warn(`Pase 3.5: Aún no se puede asignar D/F a ${emp.name} (${emp.id}) en ${dateStr}. Ranura permanece NULA.`);
                    report.push({ rule: `Info Generador - Ranura Vacía Persistente`, passed: false, details: `Empleado ${emp.name} en ${dateStr} no pudo ser asignado D/F en el llenado final.`});
                } else {
                    calculateDayTotals(day);
                }
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
  const report: ValidationResult[] = [];


  currentEmployeesState = employeesForGeneration; // Set for module-level access

  const startTime = performance.now();
  const schedule = initializeSchedule(year, month, employeesForGeneration, holidaysForGeneration);
  console.log("Estructura de horario inicializada.");

  console.log("Aplicando ausencias...");
  applyAbsences(schedule, absencesForGeneration, employeesForGeneration);
  console.log("Aplicando asignaciones/preferencias fijas...");
  applyFixedAssignments(schedule, employeesForGeneration);

  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration); // Initial totals after fixed assignments


  console.log("Iniciando pases de asignación iterativa...");
  iterativeAssignShifts(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration, report);
  console.log("Pases de asignación iterativa finalizados.");

  console.log("Calculando totales finales post-iteración...");
  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration);

  console.log("Validando horario final...");
  const finalReport = validateSchedule(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration, report); // Pass accumulated report
  const endTime = performance.now();
  console.log(`Generación de horario completada en ${(endTime - startTime).toFixed(2)} ms`);

  // Add generation time to the report, ensuring it's not duplicated if already added
  const genTimeRule = "Info Generador - Tiempo de Proceso";
  if (!finalReport.some(r => r.rule === genTimeRule)) {
      finalReport.push({ rule: genTimeRule, passed: true, details: `Proceso de generación tomó ${(endTime - startTime).toFixed(2)} ms.` });
  }
    // Sort final report once before returning
    finalReport.sort((a, b) => {
         const getPrio = (rule: string): number => {
             if (rule.includes("Completitud") || rule.includes("Ranura Vacía Persistente")) return 0;
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2 Alerta Grave")) return 1.5;
             if (rule.startsWith("Prioridad 2 Info - Asignación Relajada")) return 2.1; // Informational for relaxed
             if (rule.startsWith("Prioridad 2")) return 2;
             if (rule.startsWith("Prioridad 3")) return 3;
             if (rule.startsWith("Prioridad 4")) return 4;
             if (rule.startsWith("Prioridad 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6; 
             if (rule.startsWith("Flexible - Descanso Compensatorio")) return 6.5;
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

  return { schedule, report: finalReport };
}


