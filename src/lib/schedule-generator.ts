
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
  OperationalRules,
} from '@/types';
import { differenceInDays, format, parseISO, addDays, getDay, isWeekend, startOfMonth, endOfMonth, getDate, subDays, isValid, getDaysInMonth as getNativeDaysInMonth } from 'date-fns';
import { es } from 'date-fns/locale'; // Import Spanish locale


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

export function initializeScheduleLib(year: number, month: number, employees: Employee[], holidays: Holiday[], isNightShiftEnabled: boolean): Schedule {
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
      totals: { M: 0, T: 0, N: isNightShiftEnabled ? 0 : 0, D: 0, F: 0, LM: 0, LAO: 0, C: 0, TPT: 0 },
    };
  });

  const employeeTotals: { [employeeId: number]: EmployeeTotals } = employees.reduce((acc, emp) => {
    acc[emp.id] = {
      workedDays: 0, M: 0, T: 0, N: isNightShiftEnabled ? 0 : 0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0, C: 0
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

function applyFixedAssignments(schedule: Schedule, employees: Employee[], isNightShiftEnabled: boolean) {
    employees.forEach(employee => {
        const prefs = employee.preferences || {};

        if (prefs.fixedAssignments) {
            prefs.fixedAssignments.forEach(assignment => {
                 if (!assignment.date || !assignment.shift) return;
                 if (assignment.shift === 'N' && !isNightShiftEnabled) return;

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
            if (shift === 'N' && !isNightShiftEnabled) return;

            if(Array.isArray(daysOfWeek) && shift) {
                schedule.days.forEach(day => {
                     if (day.shifts[employee.id] === null) {
                         const currentDate = parseISO(day.date);
                         const currentDayOfWeek = getDay(currentDate);
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
    targetTypes: Array<'work' | 'nonWork' | ShiftType>,
    isNightShiftEnabled: boolean
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
    if (!scheduleStartDateString) return 0;
    const scheduleStartDate = parseISO(scheduleStartDateString);


    const isTargetType = (shift: ShiftType | null): boolean => {
        if (shift === null) return false;
        const workShifts: ShiftType[] = isNightShiftEnabled ? ['M', 'T', 'N'] : ['M', 'T'];
        if (targetTypes.includes('work') && workShifts.includes(shift)) return true;
        if (targetTypes.includes('nonWork') && (shift === 'D' || shift === 'F' || shift === 'C')) return true;
        return targetTypes.includes(shift);
    };


    while (isValid(currentDate) && currentDate >= scheduleStartDate) {
        const currentDayStr = format(currentDate, 'yyyy-MM-dd');
        const daySchedule = schedule.days.find(d => d.date === currentDayStr);
        const shift = daySchedule?.shifts[employeeId];

        if (isTargetType(shift)) {
            consecutiveDays++;
        } else {
            return consecutiveDays;
        }
        currentDate = subDays(currentDate, 1);
    }


    const history = employee.history || {};
    const historyDates = Object.keys(history).sort((a,b) => parseISO(b).getTime() - parseISO(a).getTime());

    for (const histDateStr of historyDates) {
        if (format(currentDate, 'yyyy-MM-dd') !== histDateStr) {
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
            return consecutiveDays;
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
    maxConsecutiveNonWorkDays: number,
    operationalRules: OperationalRules,
    isNightShiftEnabled: boolean,
    preferredConsecutiveWorkDays: number, // No longer directly used for blocking here
    preferredConsecutiveRestDays: number // No longer directly used for blocking here
): boolean {
    const day = schedule.days.find(d => d.date === dateStr);
    if (!day) return false;

    if (shift === null) return true;

    if (shift === 'N' && !isNightShiftEnabled) {
        return false;
    }

    const existingShift = day.shifts[employee.id];
    if ((existingShift === 'LAO' || existingShift === 'LM') && existingShift !== shift) {
        return false;
    }

    const workShifts: ShiftType[] = isNightShiftEnabled ? ['M', 'T', 'N'] : ['M', 'T'];
    const restShifts: ShiftType[] = ['D', 'F', 'C'];

    if (workShifts.includes(shift)) {
        const consecutiveWorkBefore = getConsecutiveDaysOfTypeBefore(employee.id, dateStr, schedule, employees, ['work'], isNightShiftEnabled);
        if (consecutiveWorkBefore >= maxConsecutiveWorkDays) {
            return false;
        }
        if (!relaxedMode) {
            if (isNightShiftEnabled && (shift === 'M' || shift === 'T')) {
                const prevDate = subDays(parseISO(dateStr), 1);
                const prevDateStr = format(prevDate, 'yyyy-MM-dd');
                const prevDayInSchedule = schedule.days.find(d => d.date === prevDateStr);
                let prevShiftVal: ShiftType | null = prevDayInSchedule?.shifts[employee.id] ?? employee.history?.[prevDateStr] ?? null;
                if (prevShiftVal === 'N') {
                    return false; // Cannot work M or T day after N
                }
            }
            if (shift === 'M') {
                const prevDate = subDays(parseISO(dateStr), 1);
                const prevDateStr = format(prevDate, 'yyyy-MM-dd');
                const prevDaySchedule = schedule.days.find(d => d.date === prevDateStr);
                let prevShiftVal: ShiftType | null = prevDaySchedule?.shifts[employee.id] ?? employee.history?.[prevDateStr] ?? null;
                if (prevShiftVal === 'T') return false; // Cannot work M day after T
            }
        }
    } else if (restShifts.includes(shift)) {
        const consecutiveNonWorkBefore = getConsecutiveDaysOfTypeBefore(employee.id, dateStr, schedule, employees, ['nonWork'], isNightShiftEnabled);
        if (consecutiveNonWorkBefore >= maxConsecutiveNonWorkDays) {
            return false;
        }
        if (shift === 'D' && day.isHoliday) {
            return false; // D cannot be on a holiday, use F instead if resting
        }
    }


    const prefs = employee.preferences || {};
    if (prefs.fixedAssignments?.some(a => {
        if (a.date === dateStr) {
             if (a.shift === 'N' && !isNightShiftEnabled && shift === 'N') return false;
            if (a.shift !== shift && (existingShift !== 'LAO' && existingShift !== 'LM')) {
                return true;
            }
        }
        return false;
    })) {
        return false;
    }


    if (prefs.fixedWorkShift) {
        const { dayOfWeek: daysOfWeek, shift: fixedShiftValue } = prefs.fixedWorkShift;
         if (fixedShiftValue === 'N' && !isNightShiftEnabled && shift === 'N') return false;

        if (Array.isArray(daysOfWeek) && fixedShiftValue) {
            const currentDayOfWeek = getDay(parseISO(dateStr));
            const requiresFixedShiftThisDay = daysOfWeek.includes(currentDayOfWeek) && !day.isHoliday;

            if (requiresFixedShiftThisDay) {
                if (shift !== fixedShiftValue && (existingShift !== 'LAO' && existingShift !== 'LM')) {
                    return false;
                }
            } else {
                 if (employee.eligibleWeekend === false && workShifts.includes(shift!) && (day.isWeekend || day.isHoliday)) {
                    if (existingShift !== 'LAO' && existingShift !== 'LM') {
                        return false;
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
    employees: Employee[],
    relaxedMode: boolean = false,
    maxConsecutiveWorkDays: number,
    maxConsecutiveRest: number,
    operationalRules: OperationalRules,
    isNightShiftEnabled: boolean,
    preferredConsecutiveWorkDays: number,
    preferredConsecutiveRestDays: number
) {
  const day = schedule.days.find(d => d.date === dateStr);
  if (!day) return;

  const currentShift = day.shifts[employeeId];

  if (currentShift === null || (shift === null && currentShift !== 'LAO' && currentShift !== 'LM') || (currentShift !== 'LAO' && currentShift !== 'LM')) {
      const employee = employees.find(e => e.id === employeeId);
      if (employee && canWorkShift(employee, dateStr, shift, schedule, employees, relaxedMode, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays)) {
           day.shifts[employeeId] = shift;
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

function updateSingleDayTotals(day: ScheduleDay, isNightShiftEnabled: boolean): void {
    day.totals = { M: 0, T: 0, N: 0, D: 0, F: 0, LM: 0, LAO: 0, C: 0, TPT: 0 };
    Object.values(day.shifts).forEach(s => {
        if (s === 'M') day.totals.M++;
        else if (s === 'T') day.totals.T++;
        else if (s === 'N' && isNightShiftEnabled) day.totals.N++;
        else if (s === 'D') day.totals.D++;
        else if (s === 'F') day.totals.F++;
        else if (s === 'LM') day.totals.LM++;
        else if (s === 'LAO') day.totals.LAO++;
        else if (s === 'C') day.totals.C++;
    });
    day.totals.TPT = day.totals.M + day.totals.T;
    if(!isNightShiftEnabled) day.totals.N = 0;
}


export function calculateFinalTotals(schedule: Schedule, employees: Employee[], absencesForTotals?: Absence[], isNightShiftEnabled: boolean = true) {
  schedule.days.forEach(day => {
    day.totals = { M: 0, T: 0, N:0, D: 0, F: 0, LM: 0, LAO: 0, C: 0, TPT: 0 };
  });
   employees.forEach(emp => {
        if (!schedule.employeeTotals[emp.id]) {
             schedule.employeeTotals[emp.id] = { workedDays: 0, M: 0, T: 0, N:0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0, C: 0 };
        } else {
             Object.keys(schedule.employeeTotals[emp.id]).forEach(key => {
                  (schedule.employeeTotals[emp.id] as any)[key] = 0;
             });
        }
   });

  const numDaysInMonth = schedule.days.length;

  schedule.days.forEach(day => {
    let currentDate: Date;
    try {
        currentDate = parseISO(day.date);
        if (!isValid(currentDate)) throw new Error('Fecha inválida para totales');
    } catch (e) {
        console.error(`Error parseando fecha para cálculo de totales: ${day.date}`);
        return;
    }

    const dayOfWeek = getDay(currentDate);

    Object.entries(day.shifts).forEach(([empIdStr, shiftFromGrid]) => {
        const empId = parseInt(empIdStr);
        const currentEmpTotals = schedule.employeeTotals[empId];
        if (!currentEmpTotals) {
            console.warn(`Totales de empleado no encontrados para ID ${empId} durante cálculo final.`);
            schedule.employeeTotals[empId] = { workedDays: 0, M: 0, T: 0, N:0, freeSaturdays: 0, freeSundays: 0, F: 0, D: 0, LM: 0, LAO: 0, C: 0 };
        }

        let effectiveShift = shiftFromGrid;
        const activeAbsence = absencesForTotals?.find(abs =>
            abs.employeeId === empId &&
            isValid(parseISO(abs.startDate)) && isValid(parseISO(abs.endDate)) &&
            currentDate >= parseISO(abs.startDate) && currentDate <= parseISO(abs.endDate)
        );

        if (activeAbsence) {
            effectiveShift = activeAbsence.type;
        }

        if (effectiveShift === 'M') { day.totals.M++; currentEmpTotals.M++; currentEmpTotals.workedDays++; }
        else if (effectiveShift === 'T') { day.totals.T++; currentEmpTotals.T++; currentEmpTotals.workedDays++; }
        else if (effectiveShift === 'N' && isNightShiftEnabled) { day.totals.N++; currentEmpTotals.N++; currentEmpTotals.workedDays++; }
        else if (effectiveShift === 'N' && !isNightShiftEnabled) {
             day.shifts[empId] = null;
             effectiveShift = null;
        }
        else if (effectiveShift === 'D') { day.totals.D++; currentEmpTotals.D++; }
        else if (effectiveShift === 'F') { day.totals.F++; currentEmpTotals.F++; }
        else if (effectiveShift === 'LM') { day.totals.LM++; currentEmpTotals.LM++; }
        else if (effectiveShift === 'LAO') { day.totals.LAO++; currentEmpTotals.LAO++; }
        else if (effectiveShift === 'C') { day.totals.C++; currentEmpTotals.C++; }

        const workShifts = isNightShiftEnabled ? ['M', 'T', 'N'] : ['M', 'T'];
         if (dayOfWeek === 6 && !workShifts.includes(effectiveShift!)) currentEmpTotals.freeSaturdays++;
         if (dayOfWeek === 0 && !workShifts.includes(effectiveShift!)) currentEmpTotals.freeSundays++;

    });
     day.totals.TPT = day.totals.M + day.totals.T;
     if(!isNightShiftEnabled) day.totals.N = 0;
  });

    employees.forEach(emp => {
         if (!isNightShiftEnabled && schedule.employeeTotals[emp.id]) {
            schedule.employeeTotals[emp.id].N = 0;
         }
         const totals = schedule.employeeTotals[emp.id];
         if (!totals) {
             // This can happen if an employee was in a loaded schedule but not in the current employee list
             // (e.g., if employees are loaded from CSV after schedule load)
             // console.warn(`Missing totals for employee ID ${emp.id} during final verification.`);
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

function isFullMonthLeave(employee: Employee, absences: Absence[], scheduleYear: number, scheduleMonth: number): boolean {
    return absences.some(a => {
        if (a.employeeId !== employee.id || !a.startDate || !a.endDate) return false;
        try {
            const absenceStart = parseISO(a.startDate);
            const absenceEnd = parseISO(a.endDate);
            const monthStart = startOfMonth(new Date(scheduleYear, scheduleMonth - 1));
            const monthEnd = endOfMonth(new Date(scheduleYear, scheduleMonth -1));
            return isValid(absenceStart) && isValid(absenceEnd) &&
                   absenceStart <= monthStart && absenceEnd >= monthEnd;
        } catch (e) { return false; }
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
    operationalRules: OperationalRules,
    isNightShiftEnabled: boolean,
    preferredConsecutiveWorkDays: number,
    preferredConsecutiveRestDays: number,
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
            if(fixed.shift === 'N' && !isNightShiftEnabled) return;
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
              if(fixedShift === 'N' && !isNightShiftEnabled) return;

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
                        const workShiftsCheck = isNightShiftEnabled ? ['M','T','N'] : ['M','T'];
                         if(!requiresFixedShift && emp.eligibleWeekend === false && workShiftsCheck.includes(actualShift!)){
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
     const { M, T, N, TPT } = day.totals;
     let dayPassed = true;
     let details = [];

     if (TPT < operationalRules.minCoverageTPT) {
       dayPassed = false;
       details.push(`TPT=${TPT} (<${operationalRules.minCoverageTPT})`);
     }
     if (M < operationalRules.minCoverageM) {
         dayPassed = false;
         details.push(`M=${M} (<${operationalRules.minCoverageM})`);
     }
     if (T < operationalRules.minCoverageT) {
          dayPassed = false;
         details.push(`T=${T} (<${operationalRules.minCoverageT})`);
     }
      if (isNightShiftEnabled && N < operationalRules.minCoverageN) {
         dayPassed = false;
         details.push(`N=${N} (<${operationalRules.minCoverageN})`);
     }
     if (TPT > operationalRules.minCoverageTPT && !day.isHoliday && !day.isWeekend && M <= T) {
         dayPassed = false;
         details.push(`M<=T (M=${M},T=${T}) en día laboral con TPT>${operationalRules.minCoverageTPT}`);
     }

     if(!dayPassed) {
         results.push({
           rule: `Prioridad 2 - Cobertura Mínima/Ratio M-T${isNightShiftEnabled ? '/Cobertura Noche' : ''} (${format(parseISO(day.date), 'dd/MM', { locale: es })})`,
           passed: false,
           details: `Falló: ${details.join(', ')}`,
         });
         prio2Passed = false;
     }
   });
   if (prio2Passed && !results.some(r => r.rule.startsWith('Prioridad 2 Alerta Grave') && !r.passed) && !results.some(r => r.rule.startsWith(`Prioridad 2 - Cobertura Mínima/Ratio M-T${isNightShiftEnabled ? '/Cobertura Noche' : ''} (`) && !r.passed)) {
        results.push({ rule: `Prioridad 2 - Cobertura Mínima/Ratio M-T${isNightShiftEnabled ? '/Cobertura Noche' : ''} (General)`, passed: true, details: `Cobertura mínima (M, T${isNightShiftEnabled ? ', N' : ''}) y ratio M-T en días laborales cumplidos.`});
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
           // console.warn(`Totales no encontrados para ${emp.name} durante validación Prio 3 D.`);
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
         if (getDay(date1) === 6 && getDay(date2) === 0) {
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
     if (ddWeekends < operationalRules.requiredDdWeekends) {
         results.push({
           rule: `Prioridad 4 - Fin de Semana D/D (o C/C, F/F) (${emp.name})`,
           passed: false,
           details: `Falló: Tiene ${ddWeekends} fin(es) de semana de descanso completo, requiere ${operationalRules.requiredDdWeekends}.`,
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
   let prio5WorkPassedOverall = true;

   let maxConsecutiveNonWorkOverall = 0;
   let prio5NonWorkPassedOverall = true;


   employees.forEach(emp => {
        if (isFullMonthLeave(emp, absences, schedule.year, schedule.month)) return;

       let currentConsecutiveWork = 0;
       let maxForEmployeeWork = 0;
       let currentConsecutiveNonWork = 0;
       let maxForEmployeeNonWork = 0;

       const firstDayStr = schedule.days[0]?.date;
       if(firstDayStr){
            currentConsecutiveWork = getConsecutiveDaysOfTypeBefore(emp.id, firstDayStr, schedule, employees, ['work'], isNightShiftEnabled);
            maxForEmployeeWork = currentConsecutiveWork;
            currentConsecutiveNonWork = getConsecutiveDaysOfTypeBefore(emp.id, firstDayStr, schedule, employees, ['nonWork'], isNightShiftEnabled);
            maxForEmployeeNonWork = currentConsecutiveNonWork;
       } else {
            console.warn("Horario no tiene días, no se puede calcular días consecutivos.")
            return;
       }
       const workShifts = isNightShiftEnabled ? ['M', 'T', 'N'] : ['M', 'T'];
       schedule.days.forEach(day => {
           const shift = day.shifts[emp.id];
           if (workShifts.includes(shift!)) {
               currentConsecutiveWork++;
               maxForEmployeeNonWork = Math.max(maxForEmployeeNonWork, currentConsecutiveNonWork);
               currentConsecutiveNonWork = 0;
           } else if (shift === 'D' || shift === 'F' || shift === 'C') {
               currentConsecutiveNonWork++;
               maxForEmployeeWork = Math.max(maxForEmployeeWork, currentConsecutiveWork);
               currentConsecutiveWork = 0;
           } else {
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
         }
         if (maxForEmployeeWork > maxConsecutiveWorkDays) {
             const empTotals = schedule.employeeTotals[emp.id];
             if(empTotals && (empTotals.workedDays > 0 || empTotals.M > 0 || empTotals.T > 0 || (isNightShiftEnabled && empTotals.N > 0) )) {
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
         }
         if (maxForEmployeeNonWork > maxConsecutiveNonWorkDays) {
              const empTotals = schedule.employeeTotals[emp.id];
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


    if (isNightShiftEnabled) {
        let postNightRestViolations = 0;
        let postNightRestDetails: string[] = [];
        employees.forEach(emp => {
            for (let i = 0; i < schedule.days.length -1; i++) {
                const currentDay = schedule.days[i];
                const nextDay = schedule.days[i+1];
                const currentShift = currentDay.shifts[emp.id];
                const nextShift = nextDay.shifts[emp.id];

                if (currentShift === 'N' && (nextShift === 'M' || nextShift === 'T')) {
                    postNightRestViolations++;
                    if (postNightRestDetails.length < 3) postNightRestDetails.push(`${emp.name} con ${nextShift} el ${format(parseISO(nextDay.date), 'dd/MM', { locale: es })} después de N`);
                }
            }
        });
        if (postNightRestViolations > 0) {
            results.push({
                rule: `Prioridad 5 - Descanso Post-Noche (N -> M/T día siguiente)`,
                passed: false,
                details: `Falló: ${postNightRestViolations} instancia(s). Ej: ${postNightRestDetails.join('; ')}${postNightRestViolations > 3 ? '...' : ''}`,
            });
        } else {
            results.push({
                rule: `Prioridad 5 - Descanso Post-Noche (N -> M/T día siguiente)`,
                passed: true,
                details: `Pasó: No se detectaron violaciones de descanso post-noche.`,
            });
        }
    } else {
         results.push({
            rule: `Prioridad 5 - Descanso Post-Noche (N -> M/T día siguiente)`,
            passed: true,
            details: `N/A (Turno Noche deshabilitado).`,
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
                const workShifts = isNightShiftEnabled ? ['M', 'T', 'N'] : ['M', 'T'];
                if (workShifts.includes(shiftOnHoliday!)) {
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

                            if (!['D', 'C', 'LAO', 'LM', 'F'].includes(nextDay1.shifts[emp.id]!)) {
                                missedCompensatorySat = true;
                            }
                            if (!['D', 'C', 'LAO', 'LM', 'F'].includes(nextDay2.shifts[emp.id]!)) {
                                missedCompensatorySun = true;
                            }

                            if (missedCompensatorySat || missedCompensatorySun) {
                                compensatoryRestViolations++;
                                if (compensatoryRestDetails.length < 3) {
                                    compensatoryRestDetails.push(`${emp.name} trabajó feriado ${format(parseISO(day.date), 'dd/MM', { locale: es })} y no tuvo D/C/F completo el finde sig.`);
                                }
                            }
                        }
                    }
                }
            });
        }
    });
    results.push({
        rule: `Flexible - Descanso Compensatorio (D/C/F) Finde Post-Feriado Trabajado`,
        passed: compensatoryRestViolations === 0,
        details: compensatoryRestViolations === 0
            ? 'Se otorgaron descansos D/C/F en fines de semana post-feriado trabajado donde aplicó.'
            : `${compensatoryRestViolations} instancia(s) de potencial falta de descanso D/C/F en finde post-feriado: ${compensatoryRestDetails.join('; ')}${compensatoryRestViolations > 3 ? '...' : ''}`,
    });


    let staffingDeviations = 0;
     schedule.days.forEach(day => {
        const { M, T, N } = day.totals;
        const isWorkDay = !day.isHoliday && !day.isWeekend;
        const targetM = isWorkDay ? targetStaffing.workdayMorning : targetStaffing.weekendHolidayMorning;
        const targetTValue = isWorkDay ? targetStaffing.workdayAfternoon : targetStaffing.weekendHolidayAfternoon;
        const targetNValue = isNightShiftEnabled ? (isWorkDay ? targetStaffing.workdayNight : targetStaffing.weekendHolidayNight) : 0;


         if(M !== targetM || T !== targetTValue || (isNightShiftEnabled && N !== targetNValue) ) {
             staffingDeviations++;
         }
     })
      results.push({
          rule: `Flexible 4 - Dotación Objetivo Diaria (General)`,
          passed: true,
          details: staffingDeviations === 0 ? 'Todos los días cumplieron dotación objetivo.' : `${staffingDeviations} día(s) se desviaron de la dotación objetivo (Obj Día Lab: ${targetStaffing.workdayMorning}M/${targetStaffing.workdayAfternoon}T${isNightShiftEnabled ? '/'+targetStaffing.workdayNight+'N' : ''}, Finde/Fer: ${targetStaffing.weekendHolidayMorning}M/${targetStaffing.weekendHolidayAfternoon}T${isNightShiftEnabled ? '/'+targetStaffing.weekendHolidayNight+'N' : ''}).`,
      });

    let balanceIssues = 0;
     employees.forEach(emp => {
         const empTotals = schedule.employeeTotals[emp.id];
         if (!empTotals) return;

         if(emp.preferences?.fixedWorkShift) return;

         const { M, T, N } = empTotals;
         const workShiftsCounts = isNightShiftEnabled ? [M,T,N].filter(count => count > 0) : [M,T].filter(count => count > 0);
         if (workShiftsCounts.length > 1) {
            const minCount = Math.min(...workShiftsCounts);
            const maxCount = Math.max(...workShiftsCounts);
            if (maxCount > minCount * 2 && maxCount - minCount > 5) {
                balanceIssues++;
            }
         }
     });
       results.push({
           rule: `Flexible 5 - Balance Turnos M/T${isNightShiftEnabled ? '/N' : ''} por Empleado (General)`,
           passed: true,
           details: balanceIssues === 0 ? `Conteos M/T${isNightShiftEnabled ? '/N' : ''} de empleados (sin turno fijo semanal) parecen balanceados.` : `${balanceIssues} empleado(s) muestran desbalance M/T${isNightShiftEnabled ? '/N' : ''} potencial.`,
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
                    passed: true,
                    details: `Desajustes de Preferencia: ${violations.slice(0,2).join(', ')}${violations.length > 2 ? '...' : ''}`
                });
            }
        }
    });


    let unassignedCount = 0;
    let unassignedDetails: string[] = [];
    schedule.days.forEach(day => {
        const currentDate = parseISO(day.date);
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                const isActiveAbsence = absences.some(a =>
                    a.employeeId === emp.id &&
                    isValid(parseISO(a.startDate)) && isValid(parseISO(a.endDate)) &&
                    currentDate >= parseISO(a.startDate) && currentDate <= parseISO(a.endDate)
                );

                if(!isActiveAbsence){
                   unassignedCount++;
                   if(unassignedDetails.length < 5) unassignedDetails.push(`${emp.name} en ${format(currentDate, 'dd/MM', { locale: es })}`);
                }
            }
        })
    });
     if (unassignedCount > 0) {
        results.push({
            rule: "Verificación de Completitud del Horario",
            passed: false,
            details: `Falló: ${unassignedCount} ranura(s) empleado-día siguen sin asignar (excl. ausencias activas). Ej: ${unassignedDetails.join(', ')}${unassignedCount > 5 ? '...' : ''}`,
        });
    } else {
         results.push({
            rule: "Verificación de Completitud del Horario",
            passed: true,
            details: `Pasó: Todas las ranuras empleado-día están asignadas o justificadas por ausencia activa.`,
        });
    }


     results.sort((a, b) => {
         const getPrio = (rule: string): number => {
              if (rule.includes("Completitud") || rule.includes("Ranura Vacía Persistente")) return 0;
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2 Alerta Grave")) return 1.5;
             if (rule.startsWith("Prioridad 2 Info - Asignación Relajada")) return 2.1;
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

  return results;
}


function iterativeAssignShifts(
    schedule: Schedule,
    employees: Employee[],
    absences: Absence[],
    holidays: Holiday[],
    targetStaffing: TargetStaffing,
    report: ValidationResult[],
    maxConsecutiveWorkDays: number,
    maxConsecutiveRest: number,
    operationalRules: OperationalRules,
    isNightShiftEnabled: boolean,
    preferredConsecutiveWorkDays: number,
    preferredConsecutiveRestDays: number
) {
    const baseWeekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);
    const MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING = preferredConsecutiveWorkDays;


    console.log("Iteración 1: Cobertura Esencial (M/T/N)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        updateSingleDayTotals(day, isNightShiftEnabled);

        let availableEmployees = employees.filter(e => day.shifts[e.id] === null && !isFullMonthLeave(e, absences, schedule.year, schedule.month));

        const assignShiftIfPossible = (shiftType: 'M' | 'T' | 'N', relaxed = false): boolean => {
            if (shiftType === 'N' && !isNightShiftEnabled) return false;

            const candidates = availableEmployees
                .filter(e => day.shifts[e.id] === null && canWorkShift(e, dateStr, shiftType, schedule, employees, relaxed, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays))
                .sort((a, b) => {
                    const totalsA = schedule.employeeTotals[a.id] || { workedDays: 0, M: 0, T: 0, N: 0 };
                    const totalsB = schedule.employeeTotals[b.id] || { workedDays: 0, M: 0, T: 0, N: 0 };
                    if (totalsA.workedDays !== totalsB.workedDays) {
                        return totalsA.workedDays - totalsB.workedDays;
                    }
                    if (shiftType === 'M') return totalsA.M - totalsB.M;
                    if (shiftType === 'T') return totalsA.T - totalsB.T;
                    if (shiftType === 'N' && isNightShiftEnabled) return totalsA.N - totalsB.N;
                    return Math.random() - 0.5;
                });

            if (candidates.length > 0) {
                const chosenEmployee = candidates[0];
                assignShift(chosenEmployee.id, dateStr, shiftType, schedule, employees, relaxed, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
                if (day.shifts[chosenEmployee.id] === shiftType) {
                    updateSingleDayTotals(day, isNightShiftEnabled);

                    if(schedule.employeeTotals[chosenEmployee.id]) {
                        schedule.employeeTotals[chosenEmployee.id].workedDays++;
                        if(shiftType === 'M') schedule.employeeTotals[chosenEmployee.id].M++;
                        if(shiftType === 'T') schedule.employeeTotals[chosenEmployee.id].T++;
                        if(shiftType === 'N' && isNightShiftEnabled) schedule.employeeTotals[chosenEmployee.id].N++;
                    }

                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id);
                    if(relaxed) {
                        console.warn(`Pase 1 (${dateStr}): Asignación RELAJADA de ${shiftType} a ${chosenEmployee.name} (${chosenEmployee.id}) para cobertura.`);
                        if (!report.find(r => r.rule.includes(`Asignación Relajada (${chosenEmployee.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`) && r.details?.includes(shiftType))) {
                            report.push({ rule: `Prioridad 2 Info - Asignación Relajada (${chosenEmployee.name} en ${format(parseISO(day.date), 'dd/MM', { locale: es })})`, passed: true, details: `Se asignó ${shiftType} en modo relajado para cumplir cobertura mínima.` });
                        }
                    }
                    return true;
                }
            }
            return false;
        };


        while (day.totals.M < operationalRules.minCoverageM) {
            if (!assignShiftIfPossible('M', false)) break;
        }

        while (day.totals.T < operationalRules.minCoverageT) {
            if (!assignShiftIfPossible('T', false)) break;
        }

        if (isNightShiftEnabled) {
            while (day.totals.N < operationalRules.minCoverageN) {
                if (!assignShiftIfPossible('N', false)) break;
            }
        }

        while (day.totals.TPT < operationalRules.minCoverageTPT) {
            if (day.totals.M <= day.totals.T) {
                if (assignShiftIfPossible('M', false)) continue;
                if (assignShiftIfPossible('T', false)) continue;
            } else {
                if (assignShiftIfPossible('T', false)) continue;
                if (assignShiftIfPossible('M', false)) continue;
            }
            break;
        }


        const tptStillNotMet = day.totals.TPT < operationalRules.minCoverageTPT;
        const mStillNotMet = day.totals.M < operationalRules.minCoverageM;
        const tStillNotMet = day.totals.T < operationalRules.minCoverageT;
        const nStillNotMet = isNightShiftEnabled && day.totals.N < operationalRules.minCoverageN;

        if (mStillNotMet || tStillNotMet || nStillNotMet || tptStillNotMet) {
            if(mStillNotMet) console.warn(`Pase 1 (${dateStr}): M < ${operationalRules.minCoverageM} (${day.totals.M}). Intentando con relajado para M.`);
            if(tStillNotMet) console.warn(`Pase 1 (${dateStr}): T < ${operationalRules.minCoverageT} (${day.totals.T}). Intentando con relajado para T.`);
            if(nStillNotMet) console.warn(`Pase 1 (${dateStr}): N < ${operationalRules.minCoverageN} (${day.totals.N}). Intentando con relajado para N.`);
            if(tptStillNotMet && !mStillNotMet && !tStillNotMet && !nStillNotMet ) console.warn(`Pase 1 (${dateStr}): TPT < ${operationalRules.minCoverageTPT} (${day.totals.TPT}). Intentando con relajado para TPT.`);

            availableEmployees = employees.filter(e => day.shifts[e.id] === null && !isFullMonthLeave(e, absences, schedule.year, schedule.month));


            while (day.totals.M < operationalRules.minCoverageM) {
                if (!assignShiftIfPossible('M', true)) break;
            }

            while (day.totals.T < operationalRules.minCoverageT) {
                if (!assignShiftIfPossible('T', true)) break;
            }

            if (isNightShiftEnabled) {
                while (day.totals.N < operationalRules.minCoverageN) {
                    if (!assignShiftIfPossible('N', true)) break;
                }
            }


            while (day.totals.TPT < operationalRules.minCoverageTPT) {
                let assignedInRelaxedTPTIteration = false;
                 if (day.totals.M <= day.totals.T) {
                    if (assignShiftIfPossible('M', true)) { assignedInRelaxedTPTIteration = true; }
                    else if (assignShiftIfPossible('T', true)) { assignedInRelaxedTPTIteration = true; }
                 } else {
                    if (assignShiftIfPossible('T', true)) { assignedInRelaxedTPTIteration = true; }
                    else if (assignShiftIfPossible('M', true)) { assignedInRelaxedTPTIteration = true; }
                 }

                if (!assignedInRelaxedTPTIteration) {
                    console.error(`Pase 1 (${dateStr}): IMPOSIBLE cumplir TPT >= ${operationalRules.minCoverageTPT} incluso con restricciones relajadas. Actual TPT: ${day.totals.TPT}, M: ${day.totals.M}, T: ${day.totals.T}${isNightShiftEnabled ? `, N: ${day.totals.N}` : ''}.`);
                    const ruleKey = `Prioridad 2 Alerta Grave - Cobertura TPT (${format(parseISO(day.date), 'dd/MM', { locale: es })})`;
                    if (!report.some(r => r.rule === ruleKey)) {
                        report.push({ rule: ruleKey, passed: false, details: `Falló: No se pudo alcanzar TPT >= ${operationalRules.minCoverageTPT}. TPT Actual: ${day.totals.TPT}, M: ${day.totals.M}, T: ${day.totals.T}${isNightShiftEnabled ? `, N: ${day.totals.N}` : ''}.` });
                    }
                    break;
                }
            }
        }

         updateSingleDayTotals(day, isNightShiftEnabled);
         if (day.totals.TPT > operationalRules.minCoverageTPT && !day.isHoliday && !day.isWeekend && day.totals.M <= day.totals.T) {
             console.warn(`Pase 1 (${dateStr}): TPT > ${operationalRules.minCoverageTPT} pero M (${day.totals.M}) <= T (${day.totals.T}). Intentando asignar M adicional.`);
             availableEmployees = employees.filter(e => day.shifts[e.id] === null && !isFullMonthLeave(e, absences, schedule.year, schedule.month));
             if (!assignShiftIfPossible('M', false)) {
                 assignShiftIfPossible('M', true);
             }
         }
    });
    calculateFinalTotals(schedule, employees, absences, isNightShiftEnabled);

    console.log("Iteración 2: Dotación Objetivo/Preferida");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        updateSingleDayTotals(day, isNightShiftEnabled);

        const targetM = day.isWeekend || day.isHoliday ? targetStaffing.weekendHolidayMorning : targetStaffing.workdayMorning;
        const targetTValue = day.isWeekend || day.isHoliday ? targetStaffing.weekendHolidayAfternoon : targetStaffing.workdayAfternoon;
        const targetNValue = isNightShiftEnabled ? (day.isWeekend || day.isHoliday ? targetStaffing.weekendHolidayNight : targetStaffing.workdayNight) : 0;


        let availableEmployees = employees.filter(e => day.shifts[e.id] === null && !isFullMonthLeave(e, absences, schedule.year, schedule.month));

        const assignToTarget = (shiftType: 'M' | 'T' | 'N', currentCount: number, targetCount: number) => {
            if (shiftType === 'N' && !isNightShiftEnabled) return currentCount;
            let count = currentCount;
            while (count < targetCount) {
                const candidates = availableEmployees
                    .filter(e => day.shifts[e.id] === null && canWorkShift(e, dateStr, shiftType, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays))
                    .sort((a,b) => {
                        const aTotals = schedule.employeeTotals[a.id] || { M: 0, T: 0, N: 0 };
                        const bTotals = schedule.employeeTotals[b.id] || { M: 0, T: 0, N: 0 };
                        if (shiftType === 'M') return aTotals.M - bTotals.M;
                        if (shiftType === 'T') return aTotals.T - bTotals.T;
                        if (shiftType === 'N' && isNightShiftEnabled) return aTotals.N - bTotals.N;
                        return Math.random() - 0.5;
                    });
                if (candidates.length === 0) break;
                const chosenEmployee = candidates[0];
                assignShift(chosenEmployee.id, dateStr, shiftType, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
                if (day.shifts[chosenEmployee.id] === shiftType) {
                    count++;
                    updateSingleDayTotals(day, isNightShiftEnabled);
                     if(schedule.employeeTotals[chosenEmployee.id]) {
                        schedule.employeeTotals[chosenEmployee.id].workedDays++;
                        if(shiftType === 'M') schedule.employeeTotals[chosenEmployee.id].M++;
                        if(shiftType === 'T') schedule.employeeTotals[chosenEmployee.id].T++;
                        if(shiftType === 'N' && isNightShiftEnabled) schedule.employeeTotals[chosenEmployee.id].N++;
                    }
                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id);
                } else {
                    availableEmployees = availableEmployees.filter(e => e.id !== chosenEmployee.id);
                }
            }
            return count;
        }
        assignToTarget('M', day.totals.M, targetM);
        assignToTarget('T', day.totals.T, targetTValue);
        if (isNightShiftEnabled) {
            assignToTarget('N', day.totals.N, targetNValue);
        }
    });
    calculateFinalTotals(schedule, employees, absences, isNightShiftEnabled);

    console.log("Iteración 2.5: Asignar Descanso (D/F/C) Post-Feriado Trabajado (si aplica)");
    schedule.days.forEach((day, dayIndex) => {
        if (day.isHoliday) {
            employees.forEach(emp => {
                if(isFullMonthLeave(emp,absences,schedule.year,schedule.month)) return;

                const shiftOnHoliday = day.shifts[emp.id];
                const workShifts = isNightShiftEnabled ? ['M', 'T', 'N'] : ['M', 'T'];
                if (workShifts.includes(shiftOnHoliday!)) {
                    const nextDay1Index = dayIndex + 1;
                    const nextDay2Index = dayIndex + 2;

                    if (nextDay1Index < schedule.days.length && nextDay2Index < schedule.days.length) {
                        const nextDay1 = schedule.days[nextDay1Index];
                        const nextDay2 = schedule.days[nextDay2Index];
                        const dateNextDay1 = parseISO(nextDay1.date);
                        const dateNextDay2 = parseISO(nextDay2.date);

                        if (isValid(dateNextDay1) && getDay(dateNextDay1) === 6 &&
                            isValid(dateNextDay2) && getDay(dateNextDay2) === 0) {

                            const assignCompensatory = (empToAssign: Employee, dayToAssign: ScheduleDay, shiftToAssign: ShiftType.D | ShiftType.C | ShiftType.F) => {
                                if (dayToAssign.shifts[empToAssign.id] === null || (dayToAssign.shifts[empToAssign.id] !== 'LAO' && dayToAssign.shifts[empToAssign.id] !== 'LM')) {
                                    if (canWorkShift(empToAssign, dayToAssign.date, shiftToAssign, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays)) {
                                        assignShift(empToAssign.id, dayToAssign.date, shiftToAssign, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
                                    }
                                }
                            };
                            const restShift = day.isHoliday ? 'F' : 'D';
                            assignCompensatory(emp, nextDay1, restShift);
                            assignCompensatory(emp, nextDay2, restShift);
                        }
                    }
                }
            });
        }
    });
    calculateFinalTotals(schedule, employees, absences, isNightShiftEnabled);


    console.log("Iteración 3: Asignar Descansos (D, F) apuntando a D objetivo proporcional y bloques de trabajo/descanso preferidos");
    const employeeDTargets: { [empId: number]: number } = {};
    employees.forEach(emp => {
        employeeDTargets[emp.id] = calculateEmployeeDTarget(emp, schedule, absences, baseWeekendDaysInMonth);
    });

    schedule.days.forEach(day => {
         const dateStr = day.date;
         const employeesSortedForRest = [...employees]
            .filter(emp => day.shifts[emp.id] === null && !isFullMonthLeave(emp, absences, schedule.year, schedule.month))
            .sort((a, b) => {
                const consWorkA = getConsecutiveDaysOfTypeBefore(a.id, dateStr, schedule, employees, ['work'], isNightShiftEnabled);
                const consWorkB = getConsecutiveDaysOfTypeBefore(b.id, dateStr, schedule, employees, ['work'], isNightShiftEnabled);
                const consRestA = getConsecutiveDaysOfTypeBefore(a.id, dateStr, schedule, employees, ['nonWork'], isNightShiftEnabled);
                const consRestB = getConsecutiveDaysOfTypeBefore(b.id, dateStr, schedule, employees, ['nonWork'], isNightShiftEnabled);

                // Prioridad 1: Debe descansar (alcanzó max trabajo)
                const aMustRestWork = consWorkA >= maxConsecutiveWorkDays;
                const bMustRestWork = consWorkB >= maxConsecutiveWorkDays;
                if (aMustRestWork && !bMustRestWork) return -1;
                if (!aMustRestWork && bMustRestWork) return 1;

                // Prioridad 2: Continuar bloque de descanso preferido
                const aContinuingPreferredRest = consRestA > 0 && consRestA < preferredConsecutiveRestDays && consRestA < maxConsecutiveRest;
                const bContinuingPreferredRest = consRestB > 0 && consRestB < preferredConsecutiveRestDays && consRestB < maxConsecutiveRest;
                if (aContinuingPreferredRest && !bContinuingPreferredRest) return -1;
                if (!aContinuingPreferredRest && bContinuingPreferredRest) return 1;

                // Prioridad 3: Iniciar bloque de descanso después de bloque de trabajo preferido/largo
                const aReadyForPreferredRest = consWorkA >= MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING && consWorkA < maxConsecutiveWorkDays;
                const bReadyForPreferredRest = consWorkB >= MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING && consWorkB < maxConsecutiveWorkDays;
                if (aReadyForPreferredRest && !bReadyForPreferredRest) return -1;
                if (!aReadyForPreferredRest && bReadyForPreferredRest) return 1;
                if (aReadyForPreferredRest && bReadyForPreferredRest) { // Ambos listos, desempatar por más trabajo
                    if (consWorkA !== consWorkB) return consWorkB - consWorkA;
                }
                
                // Prioridad 4: Necesidad de D para el objetivo
                const aTotals = schedule.employeeTotals[a.id] || { D: 0 };
                const bTotals = schedule.employeeTotals[b.id] || { D: 0 };
                const aNeedsDMore = aTotals.D < employeeDTargets[a.id];
                const bNeedsDMore = bTotals.D < employeeDTargets[b.id];
                if (aNeedsDMore && !bNeedsDMore) return -1;
                if (!aNeedsDMore && bNeedsDMore) return 1;

                // Prioridad 5: Desincentivar cortar bloques de trabajo cortos
                const aInShortWorkBlock = consWorkA > 0 && consWorkA < MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING && consWorkA < maxConsecutiveWorkDays;
                const bInShortWorkBlock = consWorkB > 0 && consWorkB < MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING && consWorkB < maxConsecutiveWorkDays;
                if (aInShortWorkBlock && !bInShortWorkBlock) return 1;  // b tiene más prioridad para descansar
                if (!aInShortWorkBlock && bInShortWorkBlock) return -1; // a tiene más prioridad para descansar

                // Prioridad 6: Quién ha trabajado más días consecutivos (más necesidad de descanso general)
                if (consWorkA !== consWorkB) return consWorkB - consWorkA;

                // Prioridad 7: Quién tiene menos D
                return aTotals.D - bTotals.D;
         });

         employeesSortedForRest.forEach(emp => {
             if (day.shifts[emp.id] === null) { // Re-check as shifts might be assigned within the loop
                let assignedRest = false;
                const restShiftToTry = day.isHoliday ? 'F' : 'D';

                if (canWorkShift(emp, dateStr, restShiftToTry, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays)) {
                    assignShift(emp.id, dateStr, restShiftToTry, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
                    assignedRest = day.shifts[emp.id] === restShiftToTry;
                }
                // No se intenta 'C' aquí
                
                 if(assignedRest) {
                    updateSingleDayTotals(day, isNightShiftEnabled);
                    const empTotal = schedule.employeeTotals[emp.id];
                    if(empTotal){
                        if(day.shifts[emp.id] === 'D') empTotal.D++;
                        else if(day.shifts[emp.id] === 'F') empTotal.F++;
                    }
                 }
             }
         });
     });
    calculateFinalTotals(schedule, employees, absences, isNightShiftEnabled);

    // Paso 3.5: Llenar NULOS restantes con D o F (modo estricto para descansos)
    console.log("Iteración 3.5: Llenar NULOS restantes con D o F (modo estricto para descansos)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                if (isFullMonthLeave(emp, absences, schedule.year, schedule.month)) return;

                let assignedInFill = false;
                const restShiftToTry = day.isHoliday ? 'F' : 'D';

                // Intento único con relaxedMode = false para D/F
                if (canWorkShift(emp, dateStr, restShiftToTry, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays)) {
                    assignShift(emp.id, dateStr, restShiftToTry, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
                    assignedInFill = day.shifts[emp.id] === restShiftToTry;
                }
                
                if (assignedInFill) {
                    updateSingleDayTotals(day, isNightShiftEnabled);
                    const empTotal = schedule.employeeTotals[emp.id];
                    if (empTotal) {
                        if (restShiftToTry === 'D') empTotal.D++;
                        else if (restShiftToTry === 'F') empTotal.F++;
                    }
                } else {
                    const ruleKey = `Info Generador - Ranura Vacía Persistente`;
                    const existingReportEntry = report.find(r => r.rule === ruleKey);
                    const detailMsg = `Empleado ${emp.name} (${emp.id}) en ${dateStr}`;
                    if(existingReportEntry){
                        if(existingReportEntry.details && !existingReportEntry.details.includes(detailMsg)) {
                             if((existingReportEntry.details.match(/;/g) || []).length < 2) { 
                                 existingReportEntry.details += `; ${detailMsg}`;
                             } else if (!existingReportEntry.details.endsWith("...")) {
                                 existingReportEntry.details += "...";
                             }
                        } else if(!existingReportEntry.details) {
                            existingReportEntry.details = detailMsg;
                        }
                    } else {
                         report.push({ rule: ruleKey, passed: false, details: `No se pudo asignar D/F a: ${detailMsg}`});
                    }
                }
            }
        });
    });
    calculateFinalTotals(schedule, employees, absences, isNightShiftEnabled);
}


export function generateSchedule(
  year: number,
  month: number,
  initialEmployees: Employee[],
  initialAbsences: Absence[],
  initialHolidays: Holiday[],
  targetStaffing: TargetStaffing,
  maxConsecutiveWorkDays: number,
  maxConsecutiveRest: number,
  operationalRules: OperationalRules,
  isNightShiftEnabled: boolean,
  preferredConsecutiveWorkDays: number,
  preferredConsecutiveRestDays: number
): { schedule: Schedule; report: ValidationResult[] } {

  console.log("Iniciando Generación de Horario para", { year, month, targetStaffing, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays });
  const employeesForGeneration: Employee[] = JSON.parse(JSON.stringify(initialEmployees));
  const absencesForGeneration: Absence[] = JSON.parse(JSON.stringify(initialAbsences));
  const holidaysForGeneration: Holiday[] = JSON.parse(JSON.stringify(initialHolidays));
  const report: ValidationResult[] = [];


  const startTime = performance.now();
  const schedule = initializeScheduleLib(year, month, employeesForGeneration, holidaysForGeneration, isNightShiftEnabled);
  console.log("Estructura de horario inicializada.");

  console.log("Aplicando ausencias...");
  applyAbsences(schedule, absencesForGeneration, employeesForGeneration);
  console.log("Aplicando asignaciones/preferencias fijas...");
  applyFixedAssignments(schedule, employeesForGeneration, isNightShiftEnabled);

  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration, isNightShiftEnabled);


  console.log("Iniciando pases de asignación iterativa...");
  iterativeAssignShifts(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration, targetStaffing, report, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
  console.log("Pases de asignación iterativa finalizados.");

  console.log("Calculando totales finales post-iteración...");
  calculateFinalTotals(schedule, employeesForGeneration, absencesForGeneration, isNightShiftEnabled);

  console.log("Validando horario final...");
  const finalReport = validateSchedule(schedule, employeesForGeneration, absencesForGeneration, holidaysForGeneration, targetStaffing, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays, report);
  const endTime = performance.now();
  console.log(`Generación de horario completada en ${(endTime - startTime).toFixed(2)} ms`);

  const genTimeRule = "Info Generador - Tiempo de Proceso";
  if (!finalReport.some(r => r.rule === genTimeRule)) {
      finalReport.push({ rule: genTimeRule, passed: true, details: `Proceso de generación tomó ${(endTime - startTime).toFixed(2)} ms.` });
  }
    finalReport.sort((a, b) => {
         const getPrio = (rule: string): number => {
             if (rule.includes("Completitud") || rule.includes("Ranura Vacía Persistente")) return 0;
             if (rule.startsWith("Prioridad 1")) return 1;
             if (rule.startsWith("Prioridad 2 Alerta Grave")) return 1.5;
             if (rule.startsWith("Prioridad 2 Info - Asignación Relajada")) return 2.1;
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

export function refineSchedule(
    currentSchedule: Schedule,
    employees: Employee[],
    absences: Absence[],
    holidays: Holiday[],
    targetStaffing: TargetStaffing,
    maxConsecutiveWorkDays: number,
    maxConsecutiveRest: number,
    operationalRules: OperationalRules,
    isNightShiftEnabled: boolean,
    preferredConsecutiveWorkDays: number,
    preferredConsecutiveRestDays: number
): { schedule: Schedule; report: ValidationResult[] } {
    console.log("Iniciando Refinamiento de Horario...");
    const startTime = performance.now();
    const report: ValidationResult[] = [];

    const schedule: Schedule = JSON.parse(JSON.stringify(currentSchedule));

    // 1. Preserve LAO/LM, fixed assignments, and fixed weekly shifts that are work shifts or specific rest patterns desired
    schedule.days.forEach(day => {
        const dateObj = parseISO(day.date);
        const dayOfWeek = getDay(dateObj);

        Object.keys(day.shifts).forEach(empIdStr => {
            const empId = parseInt(empIdStr);
            const employee = employees.find(e => e.id === empId);
            if (!employee) return;

            const currentShift = day.shifts[empId];

            // Preserve LAO/LM
            if (currentShift === 'LAO' || currentShift === 'LM') {
                return;
            }

            // Preserve fixed assignments (any shift type)
            const fixedAssignment = employee.preferences?.fixedAssignments?.find(fa => fa.date === day.date);
            if (fixedAssignment) {
                if (fixedAssignment.shift === 'N' && !isNightShiftEnabled) {
                    day.shifts[empId] = null; // Clear if N is fixed but disabled
                } else {
                    day.shifts[empId] = fixedAssignment.shift;
                }
                return;
            }

            // Preserve fixed weekly shifts (any shift type)
            const fixedWeekly = employee.preferences?.fixedWorkShift;
            if (fixedWeekly && Array.isArray(fixedWeekly.dayOfWeek) && fixedWeekly.shift) {
                 if (fixedWeekly.shift === 'N' && !isNightShiftEnabled) {
                    if(fixedWeekly.dayOfWeek.includes(dayOfWeek) && !day.isHoliday){
                         day.shifts[empId] = null;
                         return;
                    }
                 } else if (fixedWeekly.dayOfWeek.includes(dayOfWeek) && !day.isHoliday) {
                    day.shifts[empId] = fixedWeekly.shift;
                    return;
                }
            }
            
            // If not LAO/LM, not a fixed assignment, and not a fixed weekly shift,
            // clear D, F, C for re-evaluation. Work shifts (M,T,N) are kept.
            if (currentShift === 'D' || currentShift === 'F' || currentShift === 'C') {
                day.shifts[empId] = null;
            }
        });
    });

    calculateFinalTotals(schedule, employees, absences, isNightShiftEnabled);
    employees.forEach(emp => { // Reset D/F/C totals for employees
        if(schedule.employeeTotals[emp.id]) {
            schedule.employeeTotals[emp.id].D = 0;
            schedule.employeeTotals[emp.id].F = 0;
            schedule.employeeTotals[emp.id].C = 0;
        }
    });


    console.log("Refinamiento - Re-asignando Descansos (D, F)");
    const employeeDTargets: { [empId: number]: number } = {};
    const baseWeekendDaysInMonth = countWeekendDaysInMonth(schedule.year, schedule.month);
    employees.forEach(emp => {
        employeeDTargets[emp.id] = calculateEmployeeDTarget(emp, schedule, absences, baseWeekendDaysInMonth);
    });
    const MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING_REFINE = preferredConsecutiveWorkDays;

    schedule.days.forEach(day => {
        const dateStr = day.date;
        updateSingleDayTotals(day, isNightShiftEnabled);

        const employeesSortedForRest = [...employees]
            .filter(emp => day.shifts[emp.id] === null && !isFullMonthLeave(emp, absences, schedule.year, schedule.month))
            .sort((a, b) => {
                const consWorkA = getConsecutiveDaysOfTypeBefore(a.id, dateStr, schedule, employees, ['work'], isNightShiftEnabled);
                const consWorkB = getConsecutiveDaysOfTypeBefore(b.id, dateStr, schedule, employees, ['work'], isNightShiftEnabled);
                const consRestA = getConsecutiveDaysOfTypeBefore(a.id, dateStr, schedule, employees, ['nonWork'], isNightShiftEnabled);
                const consRestB = getConsecutiveDaysOfTypeBefore(b.id, dateStr, schedule, employees, ['nonWork'], isNightShiftEnabled);

                const aMustRestWork = consWorkA >= maxConsecutiveWorkDays;
                const bMustRestWork = consWorkB >= maxConsecutiveWorkDays;
                if (aMustRestWork && !bMustRestWork) return -1;
                if (!aMustRestWork && bMustRestWork) return 1;

                const aContinuingPreferredRest = consRestA > 0 && consRestA < preferredConsecutiveRestDays && consRestA < maxConsecutiveRest;
                const bContinuingPreferredRest = consRestB > 0 && consRestB < preferredConsecutiveRestDays && consRestB < maxConsecutiveRest;
                if (aContinuingPreferredRest && !bContinuingPreferredRest) return -1;
                if (!aContinuingPreferredRest && bContinuingPreferredRest) return 1;

                const aReadyForPreferredRest = consWorkA >= MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING_REFINE && consWorkA < maxConsecutiveWorkDays;
                const bReadyForPreferredRest = consWorkB >= MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING_REFINE && consWorkB < maxConsecutiveWorkDays;
                if (aReadyForPreferredRest && !bReadyForPreferredRest) return -1;
                if (!aReadyForPreferredRest && bReadyForPreferredRest) return 1;
                if (aReadyForPreferredRest && bReadyForPreferredRest) {
                    if (consWorkA !== consWorkB) return consWorkB - consWorkA;
                }
                
                const aTotals = schedule.employeeTotals[a.id] || { D: 0 };
                const bTotals = schedule.employeeTotals[b.id] || { D: 0 };
                const aNeedsDMore = aTotals.D < employeeDTargets[a.id];
                const bNeedsDMore = bTotals.D < employeeDTargets[b.id];
                if (aNeedsDMore && !bNeedsDMore) return -1;
                if (!aNeedsDMore && bNeedsDMore) return 1;

                const aInShortWorkBlock = consWorkA > 0 && consWorkA < MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING_REFINE && consWorkA < maxConsecutiveWorkDays;
                const bInShortWorkBlock = consWorkB > 0 && consWorkB < MIN_WORK_DAYS_BEFORE_PREFERRED_REST_FOR_SORTING_REFINE && consWorkB < maxConsecutiveWorkDays;
                if (aInShortWorkBlock && !bInShortWorkBlock) return 1;
                if (!aInShortWorkBlock && bInShortWorkBlock) return -1;

                if (consWorkA !== consWorkB) return consWorkB - consWorkA;
                return aTotals.D - bTotals.D;
         });

        employeesSortedForRest.forEach(emp => {
            if (day.shifts[emp.id] === null) {
                const restShiftToTry = day.isHoliday ? 'F' : 'D';
                assignShift(emp.id, dateStr, restShiftToTry, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
                if(day.shifts[emp.id] !== null) {
                    updateSingleDayTotals(day, isNightShiftEnabled);
                    const empTotal = schedule.employeeTotals[emp.id];
                    if(empTotal && day.shifts[emp.id] === 'D') empTotal.D++;
                    if(empTotal && day.shifts[emp.id] === 'F') empTotal.F++;
                }
            }
        });
    });

    console.log("Refinamiento - Paso 3.5: Llenar NULOS restantes con D o F (modo estricto)");
    schedule.days.forEach(day => {
        const dateStr = day.date;
        employees.forEach(emp => {
            if (day.shifts[emp.id] === null && !isFullMonthLeave(emp, absences, schedule.year, schedule.month)) {
                let assignedInFill = false;
                const restShiftToTry = day.isHoliday ? 'F' : 'D';
                
                if (canWorkShift(emp, dateStr, restShiftToTry, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays)) {
                     assignShift(emp.id, dateStr, restShiftToTry, schedule, employees, false, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays);
                     assignedInFill = day.shifts[emp.id] === restShiftToTry;
                }
                
                if (assignedInFill) {
                     updateSingleDayTotals(day, isNightShiftEnabled);
                     const empTotal = schedule.employeeTotals[emp.id];
                     if(empTotal && restShiftToTry === 'D') empTotal.D++;
                     if(empTotal && restShiftToTry === 'F') empTotal.F++;
                } else {
                    const ruleKey = `Info Generador - Ranura Vacía Persistente (Refinamiento)`;
                    const existingReportEntry = report.find(r => r.rule === ruleKey);
                    const detailMsg = `Empleado ${emp.name} (${emp.id}) en ${dateStr}`;
                     if(existingReportEntry){
                        if(existingReportEntry.details && !existingReportEntry.details.includes(detailMsg)) {
                             if((existingReportEntry.details.match(/;/g) || []).length < 2) {
                                 existingReportEntry.details += `; ${detailMsg}`;
                             } else if (!existingReportEntry.details.endsWith("...")) {
                                 existingReportEntry.details += "...";
                             }
                        } else if(!existingReportEntry.details) {
                            existingReportEntry.details = detailMsg;
                        }
                    } else {
                         report.push({ rule: ruleKey, passed: false, details: `No se pudo asignar D/F a: ${detailMsg}`});
                    }
                }
            }
        });
    });

    calculateFinalTotals(schedule, employees, absences, isNightShiftEnabled);
    const finalReport = validateSchedule(schedule, employees, absences, holidays, targetStaffing, maxConsecutiveWorkDays, maxConsecutiveRest, operationalRules, isNightShiftEnabled, preferredConsecutiveWorkDays, preferredConsecutiveRestDays, report);

    const endTime = performance.now();
    console.log(`Refinamiento de horario completado en ${(endTime - startTime).toFixed(2)} ms`);
    const genTimeRule = "Info Generador - Tiempo de Refinamiento";
    if (!finalReport.some(r => r.rule === genTimeRule)) {
        finalReport.push({ rule: genTimeRule, passed: true, details: `Proceso de refinamiento tomó ${(endTime - startTime).toFixed(2)} ms.` });
    }
    finalReport.sort((a, b) => {
        const getPrio = (rule: string): number => {
            if (rule.includes("Completitud") || rule.includes("Ranura Vacía Persistente")) return 0;
            if (rule.startsWith("Prioridad 1")) return 1;
            if (rule.startsWith("Prioridad 2 Alerta Grave")) return 1.5;
            if (rule.startsWith("Prioridad 2 Info - Asignación Relajada")) return 2.1;
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

export function calculateScheduleScore(report: ValidationResult[]): number {
    let score = 1000; 

    report.forEach(item => {
        if (!item.passed) {
            if (item.rule.startsWith("Prioridad 1") || item.rule.includes("Completitud")) {
                score -= 500; 
            } else if (item.rule.startsWith("Prioridad 2 Alerta Grave")){
                score -= 200;
            } else if (item.rule.startsWith("Prioridad 2 Info - Asignación Relajada")){
                 score -=10; // Penalización menor por asignación relajada
            } else if (item.rule.startsWith("Prioridad 2")) { 
                score -= 100; 
            } else if (item.rule.startsWith("Ranura Vacía Persistente")) {
                score -= 50; 
            } else if (item.rule.startsWith("Prioridad 3") || item.rule.startsWith("Prioridad 4") || item.rule.startsWith("Prioridad 5")) {
                score -= 25; 
            } else if (item.rule.startsWith("Flexible 1") || item.rule.startsWith("Flexible - Descanso Compensatorio") || item.rule.startsWith("Flexible 4") || item.rule.startsWith("Flexible 5")) {
                score -= 5; 
            } else if (item.rule.startsWith("Preferencia Flexible")) {
                score -= 2; 
            }
        }
    });

    return Math.max(0, score);
}

