

import type {
  Employee,
  Absence,
  Holiday,
  Schedule,
  ScheduleDay,
  ShiftType,
  ValidationResult,
  EmployeeTotals,
  TargetStaffing,
} from '@/types';
import { differenceInDays, format, parseISO, addDays, getDay, isWeekend, startOfMonth, endOfMonth, getDate, subDays, isValid, getDaysInMonth as getNativeDaysInMonth } from 'date-fns';
import { es } from 'date-fns/locale'; // Import Spanish locale

// --- Constants and Configuration ---
// Removed hardcoded MAX_CONSECUTIVE_WORK_DAYS and MAX_CONSECUTIVE_NON_WORK_DAYS
const REQUIRED_DD_WEEKENDS = 1; // Or D/C, C/D, C/C or F/F if holiday
const MIN_COVERAGE_TPT = 2;
const MIN_COVERAGE_M = 1;
const MIN_COVERAGE_T = 1;

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

export function initializeSchedule(year: number, month: number, employees: Employee[], holidays: Holiday[]): Schedule {
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
      totals: { M: 0, T: 0, D: 0, F: 0, LM: 0, LAO: 0, C: 0, TPT: 0 },
    };
  });

  const employeeTotals: { [employeeId: number]: EmployeeTotals } = employees.reduce((acc, emp) => {
    acc[emp.id] = {
      workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0, C: 0
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
        if (targetTypes.includes('nonWork') && (shift === 'D' || shift === 'F' || shift === 'C')) return true;
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
    relaxedMode: boolean = false,
    maxConsecutiveWorkDays: number,
    maxConsecutiveNonWorkDays: number
): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    if (!day) return false;

    if (shift === null) return true;

    const existingShift = day.shifts[employee.id];
    if ((existingShift === 'LAO' || existingShift === 'LM') && existingShift !== shift) {
        return false;
    }

    if (!relaxedMode) {
        if ((shift === 'M' || shift === 'T')) {
            const consecutiveWorkBefore = getConsecutiveDaysOfTypeBefore(employee.id, dateStr, schedule, employees, ['work']);
            if (consecutiveWorkBefore >= maxConsecutiveWorkDays) {
                return false;
            }
        }
        if (shift === 'M') {
            const prevDate = subDays(parseISO(dateStr), 1);
            const prevDateStr = format(prevDate, 'yyyy-MM-dd');
            const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
            let prevShiftVal: ShiftType | null = null;

            if (prevDaySchedule) {
                prevShiftVal = prevDaySchedule.shifts[employee.id];
            } else {
                prevShiftVal = employee.history?.[prevDateStr] || null;
            }
            if (prevShiftVal === 'T') return false;
        }
    }

    if (shift === 'D' || shift === 'F' || shift === 'C') {
        const consecutiveNonWorkBefore = getConsecutiveDaysOfTypeBefore(employee.id, dateStr, schedule, employees, ['nonWork']);
        if (consecutiveNonWorkBefore >= maxConsecutiveNonWorkDays) {
            return false;
        }
    }

    if (shift === 'D' && day.isHoliday) {
        return false;
    }

    const prefs = employee.preferences || {};
    if (prefs.fixedAssignments?.some(a => {
        if (a.date === dateStr) {
            // If there's a fixed assignment to D or F, prevent assigning M or T
            if ((a.shift === 'D' || a.shift === 'F' || a.shift === 'C') && (shift === 'M' || shift === 'T')) {
                return true;
            }
            // If there's a fixed assignment to M, T or D, and we're trying to assign something different (that isn't LAO/LM)
            if (a.shift !== shift && (shift === 'M' || shift === 'T' || shift === 'D' || shift === 'C') && (a.shift === 'M' || a.shift === 'T' || a.shift === 'D' || a.shift === 'C') ) {
                 return true;
            }
        }
        return false;
    })) {
        if (existingShift !== 'LAO' && existingShift !== 'LM') { // Allow LAO/LM to override fixed assignments
             return false;
        }
    }


    if (prefs.fixedWorkShift) {
        const { dayOfWeek: daysOfWeek, shift: fixedShiftValue } = prefs.fixedWorkShift;
        if (Array.isArray(daysOfWeek) && fixedShiftValue) {
            const currentDayOfWeek = getDay(parseISO(dateStr));
            const requiresFixedShiftThisDay = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

            if (requiresFixedShiftThisDay) {
                if (shift !== fixedShiftValue) { // If trying to assign something different than the fixed shift
                    if (existingShift !== 'LAO' && existingShift !== 'LM') { // And it's not an LAO/LM
                        return false;
                    }
                }
            } else { // If today is NOT a fixed shift day for this employee
                // And this employee is NOT eligible for general weekend/holiday work
                if (employee.eligibleWeekend === false && (shift === 'M' || shift === 'T')) {
                     if (day.isWeekend || day.isHoliday) { // And it's a weekend or holiday
                        if (existingShift !== 'LAO' && existingShift !== 'LM') { // And not an LAO/LM
                            return false; // Then they can't work M or T
                        }
                     }
                }
            }
        }
    }
    return true;
}

function assignShift(
    employeeId: number,
    dateStr: string,
    shift: ShiftType | null,
    schedule: Schedule,
    relaxedMode: boolean = false,
    maxConsecutiveWorkDays: number,
    maxConsecutiveNonWorkDays: number
) {
  const day = schedule.days.find(d => d.date === dateStr);
  if (!day) return;

  const currentShift = day.shifts[employeeId];

  if (currentShift === null || shift === null || (currentShift !== 'LAO' && currentShift !== 'LM')) {
      const employee = currentEmployeesState.find(e => e.id === employeeId);
      if (employee && canWorkShift(employee, dateStr, shift, schedule, currentEmployeesState, relaxedMode, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) {
           day.shifts[employeeId] = shift;
      }
  } else if(currentShift === 'LAO' || currentShift === 'LM') {
       if(shift !== currentShift && shift !== null) {
           // console.warn(`Asignación bloqueada: No se puede sobreescribir ${currentShift} con ${shift} para empleado ${employeeId} en ${dateStr}.`);
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

    const dTarget = Math.round((workableDays / totalDaysInCurrentMonth) * baseWeekendDaysInMonth);
    return Math.max(0, dTarget);
}


export function calculateFinalTotals(schedule: Schedule, employees: Employee[], absencesForTotals?: Absence[]) {
  schedule.days.forEach(day => {
    day.totals = { M: 0, T: 0, D: 0, F: 0, LM: 0, LAO: 0, C: 0, TPT: 0 };
  });
   employees.forEach(emp => {
        if (!schedule.employeeTotals[emp.id]) {
             schedule.employeeTotals[emp.id] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0, C: 0 };
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
        if (!isValid(date)) throw new Error('Fecha inválida para totales');
    } catch (e) {
        console.error(`Error parseando fecha para cálculo de totales: ${day.date}`);
        return;
    }

    const dayOfWeek = getDay(date);

    Object.entries(day.shifts).forEach(([empIdStr, shift]) => {
        const empId = parseInt(empIdStr);
        const currentEmpTotals = schedule.employeeTotals[empId];
        if (!currentEmpTotals) {
            console.warn(`Totales de empleado no encontrados para ID ${empId} durante cálculo final.`);
            schedule.employeeTotals[empId] = { workedDays: 0, M: 0, T: 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0, C: 0 };
        }

        if (shift === 'M') { day.totals.M++; currentEmpTotals.M++; currentEmpTotals.workedDays++; }
        else if (shift === 'T') { day.totals.T++; currentEmpTotals.T++; currentEmpTotals.workedDays++; }
        else if (shift === 'D') { day.totals.D++; currentEmpTotals.D++; }
        else if (shift === 'F') { day.totals.F++; currentEmpTotals.F++; }
        else if (shift === 'LM') { day.totals.LM++; currentEmpTotals.LM++; }
        else if (shift === 'LAO') { day.totals.LAO++; currentEmpTotals.LAO++; }
        else if (shift === 'C') { day.totals.C++; currentEmpTotals.C++; }


         if (dayOfWeek === 6 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSaturdays++;
         if (dayOfWeek === 0 && shift !== 'M' && shift !== 'T') currentEmpTotals.freeSundays++;

    });
     day.totals.TPT = day.totals.M + day.totals.T;
  });

    employees.forEach(emp => {
         const totals = schedule.employeeTotals[emp.id];
         if (!totals) {
             console.warn(`Faltan totales para empleado ${emp.name} (${emp.id}) durante verificación final.`);
             return;
         }
         const totalAssignedShiftsOrAbsences = totals.workedDays + totals.D + totals.F + totals.LM + totals.LAO + totals.C;

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
                // console.warn(`ALERTA: Empleado ${emp.name} (${emp.id}) desajuste de días totales. Asignados: ${totalAssignedShiftsOrAbsences}, Días del Mes: ${numDaysInMonth}`);
             }
         }
    });
}


export function validateSchedule(
    schedule: Schedule,
    employees: Employee[],
    absences: Absence[],
    holidays: Holiday[],
    targetStaffing: TargetStaffing,
    maxConsecutiveWorkDays: number,
    maxConsecutiveNonWorkDays: number,
    reportAccumulator?: ValidationResult[]
): ValidationResult[] {
  const results: ValidationResult[] = reportAccumulator || [];
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
        } catch (e) { /* ignore date parsing errors */ }
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
     if (TPT > MIN_COVERAGE_TPT && !day.isHoliday && !day.isWeekend && M <= T) {
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
                         details: `Falló: ${employee?.name || `Emp ${empIdStr}`} tiene 'D' en feriado ${format(parseISO(day.date), 'dd/MM/yyyy', { locale: es })}. Debe ser 'F' o 'C' si descansa.`,
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
         if (getDay(date1) === 6 && getDay(date2) === 0) { // Saturday and Sunday
           const shift1 = day1.shifts[emp.id];
           const shift2 = day2.shifts[emp.id];
           const isRestDay1 = shift1 === 'D' || shift1 === 'C' || (day1.isHoliday && shift1 === 'F');
           const isRestDay2 = shift2 === 'D' || shift2 === 'C' || (day2.isHoliday && shift2 === 'F');

           if (isRestDay1 && isRestDay2) {
             ddWeekends++;
           }
         }
      } catch(e){ console.warn("Error parseando fecha en validación Prio 4", e); continue; }
    }
     if (ddWeekends < REQUIRED_DD_WEEKENDS) {
         results.push({
           rule: `Prioridad 4 - Fin de Semana D/D (o C/C, F/F) (${emp.name})`,
           passed: false,
           details: `Falló: Tiene ${ddWeekends} fin(es) de semana de descanso completo, requiere ${REQUIRED_DD_WEEKENDS}.`,
         });
         prio4Passed = false;
     }
  });
    if (prio4Passed && eligibleEmployeesExist && !results.some(r => r.rule.startsWith('Prioridad 4') && !r.passed)) {
       results.push({ rule: `Prioridad 4 - Fin de Semana D/D (o C/C, F/F) (General)`, passed: true, details: 'Todos los empleados elegibles tienen su fin de semana de descanso completo.'});
   } else if (!eligibleEmployeesExist) {
        results.push({ rule: `Prioridad 4 - Fin de Semana D/D (o C/C, F/F) (General)`, passed: true, details: 'N/A (No hay empleados elegibles para fin de semana D/D).'});
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
           } else if (shift === 'D' || shift === 'F' || shift === 'C') {
               currentConsecutiveNonWork++;
               maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
               currentConsecutiveWork = 0;
           } else { // LAO, LM or null
                maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
                currentConsecutiveWork = 0;
                maxForEmployeeNonWork = Math.max(maxForEmployeeNonWork, currentConsecutiveNonWork);
                currentConsecutiveNonWork = 0;
           }
       });
        maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
        maxForEmployeeNonWork = Math.max(maxForEmployeeNonWork, currentConsecutiveNonWork);

         if(maxForEmployeeWork > maxConsecutiveWorkOverall){
             maxConsecutiveWorkOverall = maxForEmployeeWork;
             maxConsecutiveWorkEmployee = emp.name;
         }
         if (maxForEmployeeWork > maxConsecutiveWorkDays) {
             const empTotals = schedule.employeeTotals[emp.id];
             // Only report if employee actually worked during the month (not full LAO/LM)
             if(empTotals && (empTotals.workedDays > 0 || empTotals.M > 0 || empTotals.T > 0)) {
                  results.push({
                      rule: `Prioridad 5 - Máx Días Consecutivos de Trabajo (${emp.name})`,
                      passed: false,
                      details: `Falló: Trabajó ${maxForEmployeeWork} días consecutivos (Máx ${maxConsecutiveWorkDays})`,
                  });
                  prio5WorkPassedOverall = false;
              }
         }

         if(maxForEmployeeNonWork > maxConsecutiveNonWorkOverall){
             maxConsecutiveNonWorkOverall = maxForEmployeeNonWork;
             maxConsecutiveNonWorkEmployee = emp.name;
         }
         if (maxForEmployeeNonWork > maxConsecutiveNonWorkDays) {
              const empTotals = schedule.employeeTotals[emp.id];
               // Only report if employee actually had D/F/C days (not full LAO/LM or all work)
               if(empTotals && (empTotals.D > 0 || empTotals.F > 0 || empTotals.C > 0)) {
                    results.push({
                        rule: `Prioridad 5 - Máx Días No Laborables (D/F/C) Consecutivos (${emp.name})`,
                        passed: false,
                        details: `Falló: Tuvo ${maxForEmployeeNonWork} días no laborables (D/F/C) consecutivos (Máx ${maxConsecutiveNonWorkDays})`,
                    });
                    prio5NonWorkPassedOverall = false;
                }
         }
   });
    if (prio5WorkPassedOverall && !results.some(r => r.rule.startsWith('Prioridad 5 - Máx Días Consecutivos de Trabajo (') && !r.passed)) {
         results.push({
            rule: `Prioridad 5 - Máx Días Consecutivos de Trabajo (General)`,
            passed: true,
            details: `Pasó (Máx encontrado: ${maxConsecutiveWorkOverall}, Límite: ${maxConsecutiveWorkDays})`
        });
    }
    if (prio5NonWorkPassedOverall && !results.some(r => r.rule.startsWith('Prioridad 5 - Máx Días No Laborables (D/F/C) Consecutivos (') && !r.passed)) {
        results.push({
            rule: `Prioridad 5 - Máx Días No Laborables (D/F/C) Consecutivos (General)`,
            passed: true,
            details: `Pasó (Máx encontrado: ${maxConsecutiveNonWorkOverall}, Límite: ${maxConsecutiveNonWorkDays})`
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
                      let prevShiftVal: ShiftType | null = null;
                      if (prevDaySchedule) {
                          prevShiftVal = prevDaySchedule.shifts[emp.id];
                      } else {
                          prevShiftVal = emp.history?.[prevDateStr] || null;
                      }

                     if (prevShiftVal === 'T') {
                        t_m_violations++;
                        if (t_m_details.length < 3) t_m_details.push(`${emp.name} en ${format(parseISO(currentDayDateStr), 'dd/MM', { locale: es })}`);
                     }
                 }
              } catch (e) { /* Ignore date parsing errors */ }
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
                    const nextDay1Index = dayIndex + 1;
                    const nextDay2Index = dayIndex + 2;

                    if (nextDay1Index < schedule.days.length && nextDay2Index < schedule.days.length) {
                        const nextDay1 = schedule.days[nextDay1Index];
                        const nextDay2 = schedule.days[nextDay2Index];

                        const dateNextDay1 = parseISO(nextDay1.date);
                        const dateNextDay2 = parseISO(nextDay2.date);

                        if (isValid(dateNextDay1) && getDay(dateNextDay1) === 6 && // Saturday
                            isValid(dateNextDay2) && getDay(dateNextDay2) === 0) { // Sunday
                            
                            let missedCompensatorySat = false;
                            let missedCompensatorySun = false;

                            // Expect D or C (or LAO/LM which are unavoidable)
                            if (!['D', 'C', 'LAO', 'LM'].includes(nextDay1.shifts[emp.id]!)) {
                                missedCompensatorySat = true;
                            }
                            if (!['D', 'C', 'LAO', 'LM'].includes(nextDay2.shifts[emp.id]!)) {
                                missedCompensatorySun = true;
                            }

                            if (missedCompensatorySat || missedCompensatorySun) {
                                compensatoryRestViolations++;
                                if (compensatoryRestDetails.length < 3) {
                                    compensatoryRestDetails.push(`${emp.name} trabajó feriado ${format(parseISO(day.date), 'dd/MM', { locale: es })} y no tuvo D/C completo el finde sig.`);
                                }
                            }
                        }
                    }
                }
            });
        }
    });
    results.push({
        rule: `Flexible - Descanso Compensatorio (D/C) Finde Post-Feriado Trabajado`,
        passed: compensatoryRestViolations === 0,
        details: compensatoryRestViolations === 0
            ? 'Se otorgaron descansos D/C en fines de semana post-feriado trabajado donde aplicó.'
            : `${compensatoryRestViolations} instancia(s) de potencial falta de descanso D/C en finde post-feriado: ${compensatoryRestDetails.join('; ')}${compensatoryRestViolations > 3 ? '...' : ''}`,
    });


    let staffingDeviations = 0;
     schedule.days.forEach(day => {
        const { M, T } = day.totals;
        const isWorkDay = !day.isHoliday && !day.isWeekend;
        const targetM = isWorkDay ? targetStaffing.workdayMorning : targetStaffing.weekendHolidayMorning;
        const targetTValue = isWorkDay ? targetStaffing.workdayAfternoon : targetStaffing.weekendHolidayAfternoon;

         if(M !== targetM || T !== targetTValue) {
             staffingDeviations++;
         }
     })
      results.push({
          rule: `Flexible 4 - Dotación Objetivo Diaria (General)`,
          passed: true,
          details: staffingDeviations === 0 ? 'Todos los días cumplieron dotación objetivo.' : `${staffingDeviations} día(s) se desviaron de la dotación objetivo (Obj Día Lab: ${targetStaffing.workdayMorning}M/${targetStaffing.workdayAfternoon}T, Finde/Fer: ${targetStaffing.weekendHolidayMorning}M/${targetStaffing.weekendHolidayAfternoon}T).`,
      });

    let balanceIssues = 0;
     employees.forEach(emp => {
         const empTotals = schedule.employeeTotals[emp.id];
         if (!empTotals) return;

         if(emp.preferences?.fixedWorkShift) return; // Exclude those with fixed weekly shifts from general M/T balance check

         const { M, T } = empTotals;
         const totalShifts = M + T;
         if (totalShifts > 0) {
             const diff = Math.abs(M - T);
             const imbalanceThreshold = Math.max(3, Math.floor(totalShifts * 0.25)); // e.g. >3 or >25% difference
             if (diff > imbalanceThreshold) {
                balanceIssues++;
             }
         }
     });
       results.push({
           rule: `Flexible 5 - Balance Turnos M/T por Empleado (General)`,
           passed: true,
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

                     if (prefs.preferWeekendWork && (shift === 'D' || shift === 'F' || shift === 'C') && day.isWeekend) {
                        violations.push(`Franco/Libre en finde de trabajo preferido ${format(date, 'dd/MM', { locale: es })}`);
                     }
                } catch (e) { /* Ignore date parsing issues */ }
            })
             if (violations.length > 0) {
                results.push({
                    rule: `Preferencia Flexible - ${emp.name}`,
                    passed: true, // These are preferences, so not a "failure" if not met
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
                // Check if employee is on full month leave
                const isOnLeaveFullMonth = absences.some(a => {
                    if (a.employeeId !== emp.id || !a.startDate || !a.endDate) return false;
                    try {
                        const absenceStart = parseISO(a.startDate);
                        const absenceEnd = parseISO(a.endDate);
                        const monthStart = startOfMonth(parseISO(day.date));
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


     results.sort((a, b) => {
         const getPrio = (rule: string): number => {
              if (rule.includes("Completitud") || rule.includes("Ranura Vacía Persistente")) return 0;
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2 Alerta Grave")) return 1.5; // Critical failure
             if (rule.startsWith("Prioridad 2 Info - Asignación Relajada")) return 2.1; // Info about relaxation
             if (rule.startsWith("Prioridad 2")) return 2;
             if (rule.startsWith("Prioridad 3")) return 3;
             if (rule.startsWith("Prioridad 4")) return 4;
             if (rule.startsWith("Prioridad 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6; // T->M
             if (rule.startsWith("Flexible - Descanso Compensatorio")) return 6.5;
             if (rule.startsWith("Flexible 5")) return 7; // Balance M/T
             if (rule.startsWith("Flexible 4")) return 8; // Staffing Target
             if (rule.startsWith("Preferencia Flexible")) return 9;
             if (rule.startsWith("Flexible")) return 10; // Other flexibles
             if (rule.startsWith("Info Generador")) return 12; // Meta-info
             return 11; // Default for anything else
         }
         const prioA = getPrio(a.rule);
         const prioB = getPrio(b.rule);

         if (prioA !== prioB) return prioA - prioB; // Sort by priority number first
         if (a.passed !== b.passed) return a.passed ? 1 : -1; // Failures first within same priority
         return a.rule.localeCompare(b.rule); // Alphabetical for same priority and pass status
     });

  return results;
}

// Global or passed-in state for current employees, accessible by assignShift
let currentEmployeesState: Employee[] = [];

function iterativeAssignShifts(
    schedule: Schedule,
    employees: Employee[],
    absences: Absence[],
    holidays: Holiday[],
    targetStaffing: TargetStaffing,
    report: ValidationResult[],
    maxConsecutiveWorkDays: number,
    maxConsecutiveNonWorkDays: number
) {
    const baseWeekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);
    currentEmployeesState = employees; // Make employees accessible to assignShift via this module-level variable

    const calculateDayTotals = (day: ScheduleDay) => {
        day.totals = { M: 0, T: 0, D: 0, F: 0, LM: 0, LAO: 0, C: 0, TPT: 0 };
        Object.values(day.shifts).forEach(s => {
            if (s === 'M') day.totals.M++;
            else if (s === 'T') day.totals.T++;
            else if (s === 'D') day.totals.D++;
            else if (s === 'F') day.totals.F++;
            else if (s === 'LM') day.totals.LM++;
            else if (s === 'LAO') day.totals.LAO++;
            else if (s === 'C') day.totals.C++;
        });
        day.totals.TPT = day.totals.M + day.totals.T;
    };


    console.log("Iteración 1: Cobertura Esencial (M/T)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        calculateDayTotals(day); // Initial calculation for the day

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null);

        const assignShiftIfPossible = (shiftType: 'M' | 'T', relaxed = false): boolean => {
            const candidates = availableEmployees
                .filter(e => day.shifts[e.id] === null && canWorkShift(e, dateStr, shiftType, schedule, employees, relaxed, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays))
                .sort((a, b) => { // Prioritize employees with fewer worked days / fewer of this shift type
                    const totalsA = schedule.employeeTotals[a.id] || { workedDays: 0, M: 0, T: 0 };
                    const totalsB = schedule.employeeTotals[b.id] || { workedDays: 0, M: 0, T: 0 };
                    if (totalsA.workedDays !== totalsB.workedDays) {
                        return totalsA.workedDays - totalsB.workedDays;
                    }
                    return shiftType === 'M' ? (totalsA.M - totalsB.M) : (totalsA.T - totalsB.T);
                });

            if (candidates.length > 0) {
                const chosenEmployee = candidates[0];
                assignShift(chosenEmployee.id, dateStr, shiftType, schedule, relaxed, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                if (day.shifts[chosenEmployee.id] === shiftType) { // Check if assignment was successful
                    calculateDayTotals(day); // Recalculate day totals after successful assignment
                    
                    // Update employee totals immediately after successful assignment
                    if(schedule.employeeTotals[chosenEmployee.id]) {
                        schedule.employeeTotals[chosenEmployee.id].workedDays++;
                        if(shiftType === 'M') schedule.employeeTotals[chosenEmployee.id].M++;
                        if(shiftType === 'T') schedule.employeeTotals[chosenEmployee.id].T++;
                    }

                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id); // Remove assigned employee
                    if(relaxed) {
                        console.warn(`Pass 1 (${dateStr}): Asignación RELAJADA de ${shiftType} a ${chosenEmployee.name} (${chosenEmployee.id}) para cobertura.`);
                        // Add to report only if not already added for this employee/day/shift combo
                        if (!report.find(r => r.rule.includes(`Asignación Relajada (${chosenEmployee.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`) && r.details?.includes(shiftType))) {
                            report.push({ rule: `Prioridad 2 Info - Asignación Relajada (${chosenEmployee.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`, passed: true, details: `Se asignó ${shiftType} en modo relajado para cumplir cobertura mínima. Puede violar MAX_CONSECUTIVE_WORK o T->M.` });
                        }
                    }
                    return true;
                }
            }
            return false;
        };

        // Ensure M >= 1
        while (day.totals.M < MIN_COVERAGE_M) {
            if (!assignShiftIfPossible('M', false)) break;
        }
        // Ensure T >= 1
        while (day.totals.T < MIN_COVERAGE_T) {
            if (!assignShiftIfPossible('T', false)) break;
        }
        // Ensure TPT >= 2
        while (day.totals.TPT < MIN_COVERAGE_TPT) {
            // Prioritize M if it's lower or equal to T to help meet M>T rule later if TPT > 2
            if (day.totals.M <= day.totals.T) {
                if (assignShiftIfPossible('M', false)) continue;
                if (assignShiftIfPossible('T', false)) continue; // Fallback to T if M can't be assigned
            } else { // Prioritize T if M is already higher
                if (assignShiftIfPossible('T', false)) continue;
                if (assignShiftIfPossible('M', false)) continue; // Fallback to M if T can't be assigned
            }
            break; // Can't assign more with standard rules
        }

        // If still not meeting coverage, try with relaxed rules
        if (day.totals.M < MIN_COVERAGE_M || day.totals.T < MIN_COVERAGE_T || day.totals.TPT < MIN_COVERAGE_TPT) {
            if(day.totals.M < MIN_COVERAGE_M) console.warn(`Pass 1 (${dateStr}): M < ${MIN_COVERAGE_M} (${day.totals.M}). Intentando con restricciones relajadas para M.`);
            if(day.totals.T < MIN_COVERAGE_T) console.warn(`Pass 1 (${dateStr}): T < ${MIN_COVERAGE_T} (${day.totals.T}). Intentando con restricciones relajadas para T.`);
            if(day.totals.TPT < MIN_COVERAGE_TPT && !(day.totals.M < MIN_COVERAGE_M || day.totals.T < MIN_COVERAGE_T) ) console.warn(`Pass 1 (${dateStr}): TPT < ${MIN_COVERAGE_TPT} (${day.totals.TPT}). Intentando con restricciones relajadas para TPT.`);
            
            availableEmployees = employees.filter(e => day.shifts[e.id] === null); // Refresh available employees for relaxed pass

            // Relaxed pass for M >= 1
            while (day.totals.M < MIN_COVERAGE_M) {
                if (!assignShiftIfPossible('M', true)) break; // relaxed = true
            }
            // Relaxed pass for T >= 1
            while (day.totals.T < MIN_COVERAGE_T) {
                if (!assignShiftIfPossible('T', true)) break; // relaxed = true
            }
            
            // Relaxed pass for TPT >= 2
            while (day.totals.TPT < MIN_COVERAGE_TPT) {
                let assignedInRelaxedTPTIteration = false;
                 if (day.totals.M <= day.totals.T) { // Prioritize M if it's lower or equal
                    if (assignShiftIfPossible('M', true)) { // relaxed = true
                        assignedInRelaxedTPTIteration = true;
                    } else if (assignShiftIfPossible('T', true)) { // relaxed = true
                        assignedInRelaxedTPTIteration = true;
                    }
                 } else { // Prioritize T if M is higher
                    if (assignShiftIfPossible('T', true)) { // relaxed = true
                        assignedInRelaxedTPTIteration = true;
                    } else if (assignShiftIfPossible('M', true)) { // relaxed = true
                        assignedInRelaxedTPTIteration = true;
                    }
                 }


                if (!assignedInRelaxedTPTIteration) {
                    console.error(`Pass 1 (${dateStr}): IMPOSIBLE cumplir TPT >= ${MIN_COVERAGE_TPT} incluso con restricciones relajadas. Actual TPT: ${day.totals.TPT}, M: ${day.totals.M}, T: ${day.totals.T}.`);
                    const ruleKey = `Prioridad 2 Alerta Grave - Cobertura TPT (${format(parseISO(day.date), 'dd/MM', { locale: es })})`;
                    if (!report.some(r => r.rule === ruleKey)) { // Avoid duplicate critical errors for the same day
                        report.push({ rule: ruleKey, passed: false, details: `Falló: No se pudo alcanzar TPT >= ${MIN_COVERAGE_TPT}. TPT Actual: ${day.totals.TPT}, M: ${day.totals.M}, T: ${day.totals.T}. Posibles causas: empleados no disponibles (LAO/LM) o conflictos con asignaciones/preferencias fijas no flexibles.` });
                    }
                    break; // Exit loop if no assignment possible
                }
            }
        }
         // Final check for M > T if TPT > 2 on workdays
         calculateDayTotals(day); // Recalculate totals one last time for the day after all M/T assignments
         if (day.totals.TPT > MIN_COVERAGE_TPT && !day.isHoliday && !day.isWeekend && day.totals.M <= day.totals.T) {
             console.warn(`Pass 1 (${dateStr}): TPT > ${MIN_COVERAGE_TPT} pero M (${day.totals.M}) <= T (${day.totals.T}). Intentando asignar M adicional.`);
             availableEmployees = employees.filter(e => day.shifts[e.id] === null); // Refresh available employees
             if (!assignShiftIfPossible('M', false)) { // Try standard first
                 assignShiftIfPossible('M', true);    // Then relaxed if needed
             }
         }
    });
    calculateFinalTotals(schedule, employees, absences); // Calculate all employee totals after Pass 1

    console.log("Iteración 2: Dotación Objetivo/Preferida");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        calculateDayTotals(day); // Ensure day totals are fresh
        
        const targetM = day.isWeekend || day.isHoliday ? targetStaffing.weekendHolidayMorning : targetStaffing.workdayMorning;
        const targetTValue = day.isWeekend || day.isHoliday ? targetStaffing.weekendHolidayAfternoon : targetStaffing.workdayAfternoon;

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null);

        // Helper function to assign shifts to meet target, prioritizing those with fewer of that shift type
        const assignToTarget = (shiftType: 'M' | 'T', currentCount: number, targetCount: number) => {
            let count = currentCount;
            while (count < targetCount) {
                const candidates = availableEmployees
                    .filter(e => day.shifts[e.id] === null && canWorkShift(e, dateStr, shiftType, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) // Standard mode only for target staffing
                    .sort((a,b) => (shiftType === 'M' ? (schedule.employeeTotals[a.id]?.M || 0) - (schedule.employeeTotals[b.id]?.M || 0) 
                                                     : (schedule.employeeTotals[a.id]?.T || 0) - (schedule.employeeTotals[b.id]?.T || 0)));
                if (candidates.length === 0) break;
                const chosenEmployee = candidates[0];
                assignShift(chosenEmployee.id, dateStr, shiftType, schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                if (day.shifts[chosenEmployee.id] === shiftType) {
                    count++;
                    calculateDayTotals(day); // Recalculate day totals
                     // Update employee totals
                     if(schedule.employeeTotals[chosenEmployee.id]) {
                        schedule.employeeTotals[chosenEmployee.id].workedDays++;
                        if(shiftType === 'M') schedule.employeeTotals[chosenEmployee.id].M++;
                        if(shiftType === 'T') schedule.employeeTotals[chosenEmployee.id].T++;
                    }
                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id);
                } else {
                    // If assignShift failed (canWorkShift returned false internally), remove candidate to avoid infinite loop
                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id);
                }
            }
            return count;
        }
        assignToTarget('M', day.totals.M, targetM);
        assignToTarget('T', day.totals.T, targetTValue); // Use targetTValue consistently
    });
    calculateFinalTotals(schedule, employees, absences); // Recalculate all employee totals after Pass 2

    console.log("Iteración 2.5: Asignar Descanso Compensatorio (D/C) Post-Feriado");
    schedule.days.forEach((day, dayIndex) => {
        if (day.isHoliday) {
            employees.forEach(emp => {
                const shiftOnHoliday = day.shifts[emp.id];
                if (shiftOnHoliday === 'M' || shiftOnHoliday === 'T') {
                    // Check if the next two days are Saturday and Sunday
                    const nextDay1Index = dayIndex + 1;
                    const nextDay2Index = dayIndex + 2;

                    if (nextDay1Index < schedule.days.length && nextDay2Index < schedule.days.length) {
                        const nextDay1 = schedule.days[nextDay1Index];
                        const nextDay2 = schedule.days[nextDay2Index];
                        const dateNextDay1 = parseISO(nextDay1.date);
                        const dateNextDay2 = parseISO(nextDay2.date);

                        if (isValid(dateNextDay1) && getDay(dateNextDay1) === 6 && // Saturday
                            isValid(dateNextDay2) && getDay(dateNextDay2) === 0) { // Sunday

                            // Attempt to assign D or C, prioritizing D
                            const assignCompensatory = (empToAssign: Employee, dayToAssign: ScheduleDay, shiftToAssign: ShiftType.D | ShiftType.C) => {
                                if (dayToAssign.shifts[empToAssign.id] === null || (dayToAssign.shifts[empToAssign.id] !== 'LAO' && dayToAssign.shifts[empToAssign.id] !== 'LM')) {
                                    if (canWorkShift(empToAssign, dayToAssign.date, shiftToAssign, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) {
                                        assignShift(empToAssign.id, dayToAssign.date, shiftToAssign, schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                                    }
                                }
                            };
                            assignCompensatory(emp, nextDay1, 'D');
                            assignCompensatory(emp, nextDay2, 'D');
                        }
                    }
                }
            });
        }
    });
    calculateFinalTotals(schedule, employees, absences);


    console.log("Iteración 3: Asignar Descansos (D, F) apuntando a D objetivo proporcional y respetando MAX_CONSECUTIVE_NON_WORK_DAYS");
    const employeeDTargets: { [empId: number]: number } = {};
    employees.forEach(emp => {
        employeeDTargets[emp.id] = calculateEmployeeDTarget(emp, schedule, absences, baseWeekendDaysInMonth);
    });

    schedule.days.forEach(day => {
         const dateStr = day.date;
         // Sort employees: those needing D most, then by fewest total D assigned
         const employeesSortedForRest = [...employees].sort((a, b) => {
             const aTotals = schedule.employeeTotals[a.id] || { D: 0 };
             const bTotals = schedule.employeeTotals[b.id] || { D: 0 };
             const needsDA = aTotals.D < employeeDTargets[a.id];
             const needsDB = bTotals.D < employeeDTargets[b.id];

             if (needsDA && !needsDB) return -1; // a needs D more urgently
             if (!needsDA && needsDB) return 1;  // b needs D more urgently

             // If both need D similarly or neither need it urgently, prioritize by fewest D assigned
             return aTotals.D - bTotals.D;
         });

         employeesSortedForRest.forEach(emp => {
             if (day.shifts[emp.id] === null) { // Only if slot is empty
                // Skip if employee is on full month leave (unlikely to have nulls then, but good check)
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
                     // On holiday, prefer 'F' if possible
                     if (canWorkShift(emp, dateStr, 'F', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) {
                        assignShift(emp.id, dateStr, 'F', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                     } else if (canWorkShift(emp, dateStr, 'D', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) { // Fallback to D if F isn't possible (e.g., MAX_CONSECUTIVE_NON_WORK)
                        assignShift(emp.id, dateStr, 'D', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                     }
                 } else {
                     // On non-holiday, prefer 'D' if target not met, or if possible
                     if ((schedule.employeeTotals[emp.id]?.D || 0) < employeeDTargets[emp.id] && canWorkShift(emp, dateStr, 'D', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) {
                          assignShift(emp.id, dateStr, 'D', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                     } else if (canWorkShift(emp, dateStr, 'D', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) { // If D target is met, still try D if possible
                        assignShift(emp.id, dateStr, 'D', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                     } else if (canWorkShift(emp, dateStr, 'F', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) { // Fallback to F (e.g. if max D met, but F still allowed by non-work day limit)
                        assignShift(emp.id, dateStr, 'F', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                     }
                 }
                 // If a shift was assigned, recalculate day totals
                 if(day.shifts[emp.id] !== null) calculateDayTotals(day);
             }
         });
     });
    calculateFinalTotals(schedule, employees, absences); // Recalculate all totals after Pass 3

    console.log("Iteración 3.5: Llenar NULOS restantes con D o F robustamente (respetando MAX_CONSECUTIVE_NON_WORK_DAYS)");
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
                if (day.isHoliday) { // Prefer F on holidays if filling
                    if (canWorkShift(emp, dateStr, 'F', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) {
                        assignShift(emp.id, dateStr, 'F', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                        assignedInFill = day.shifts[emp.id] === 'F';
                    }
                }
                if (!assignedInFill) { // If not holiday, or F failed on holiday
                    if (canWorkShift(emp, dateStr, 'D', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) {
                        assignShift(emp.id, dateStr, 'D', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                        assignedInFill = day.shifts[emp.id] === 'D';
                    } else if (canWorkShift(emp, dateStr, 'F', schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays)) { // Try F again if D failed (e.g., D on holiday blocked)
                        assignShift(emp.id, dateStr, 'F', schedule, false, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
                        assignedInFill = day.shifts[emp.id] === 'F';
                    }
                }
                 
                if (!assignedInFill) { 
                    console.warn(`Pase 3.5: Aún no se puede asignar D/F a ${emp.name} (${emp.id}) en ${dateStr}. Ranura permanece NULA.`);
                    report.push({ rule: `Info Generador - Ranura Vacía Persistente`, passed: false, details: `Empleado ${emp.name} en ${dateStr} no pudo ser asignado D/F en el llenado final.`});
                } else {
                    calculateDayTotals(day); // Recalculate if shift was assigned
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
  initialAbsences: Absence[],
  initialHolidays: Holiday[],
  targetStaffing: TargetStaffing,
  maxConsecutiveWorkDays: number,
  maxConsecutiveNonWorkDays: number
): { schedule: Schedule; report: ValidationResult[] } {

  console.log("Iniciando Generación de Horario para", { year, month, targetStaffing, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays });
  const employeesForGeneration: Employee[] = JSON.parse(JSON.stringify(initialEmployees));
  const absencesForGeneration: Absence[] = JSON.parse(JSON.stringify(initialAbsences));
  const holidaysForGeneration: Holiday[] = JSON.parse(JSON.stringify(initialHolidays));
  const report: ValidationResult[] = [];


  currentEmployeesState = employeesForGeneration; // Set module-level state

  const startTime = performance.now();
  const schedule = initializeSchedule(year, month, employeesForGeneration, holidaysForGeneration);
  console.log("Estructura de horario inicializada.");

  console.log("Aplicando ausencias...");
  applyAbsences(schedule, absencesForGeneration, employeesForGeneration);
  console.log("Aplicando asignaciones/preferencias fijas...");
  applyFixedAssignments(schedule, employeesForGeneration);

  // Calculate initial totals based on absences and fixed assignments
  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration);


  console.log("Iniciando pases de asignación iterativa...");
  iterativeAssignShifts(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration, targetStaffing, report, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays);
  console.log("Pases de asignación iterativa finalizados.");

  console.log("Calculando totales finales post-iteración...");
  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration);

  console.log("Validando horario final...");
  const finalReport = validateSchedule(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration, targetStaffing, maxConsecutiveWorkDays, maxConsecutiveNonWorkDays, report);
  const endTime = performance.now();
  console.log(`Generación de horario completada en ${(endTime - startTime).toFixed(2)} ms`);

  // Add generation time to report if not already there through some other means
  const genTimeRule = "Info Generador - Tiempo de Proceso";
  if (!finalReport.some(r => r.rule === genTimeRule)) {
      finalReport.push({ rule: genTimeRule, passed: true, details: `Proceso de generación tomó ${(endTime - startTime).toFixed(2)} ms.` });
  }
    // Ensure report is sorted by priority and pass/fail status
    finalReport.sort((a, b) => {
         const getPrio = (rule: string): number => {
             if (rule.includes("Completitud") || rule.includes("Ranura Vacía Persistente")) return 0;
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2 Alerta Grave")) return 1.5; // Critical failure
             if (rule.startsWith("Prioridad 2 Info - Asignación Relajada")) return 2.1; // Info about relaxation
             if (rule.startsWith("Prioridad 2")) return 2;
             if (rule.startsWith("Prioridad 3")) return 3;
             if (rule.startsWith("Prioridad 4")) return 4;
             if (rule.startsWith("Prioridad 5")) return 5;
             if (rule.startsWith("Flexible 1")) return 6; // T->M
             if (rule.startsWith("Flexible - Descanso Compensatorio")) return 6.5;
             if (rule.startsWith("Flexible 5")) return 7; // Balance M/T
             if (rule.startsWith("Flexible 4")) return 8; // Staffing Target
             if (rule.startsWith("Preferencia Flexible")) return 9;
             if (rule.startsWith("Flexible")) return 10; // Other flexibles
             if (rule.startsWith("Info Generador")) return 12; // Meta-info
             return 11; // Default for anything else
         }
         const prioA = getPrio(a.rule);
         const prioB = getPrio(b.rule);
         if (prioA !== prioB) return prioA - prioB; // Sort by priority number first
         if (a.passed !== b.passed) return a.passed ? 1 : -1; // Failures first within same priority
         return a.rule.localeCompare(b.rule); // Alphabetical for same priority and pass status
     });

  return { schedule, report: finalReport };
}

