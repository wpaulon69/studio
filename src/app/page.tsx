
"use client";

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { generateSchedule, calculateFinalTotals, validateSchedule, initializeScheduleLib, refineSchedule, calculateScheduleScore } from '@/lib/schedule-generator';
import type { Schedule, ValidationResult, Employee, Absence, Holiday, ShiftType, TargetStaffing, OperationalRules } from '@/types';
import { SHIFT_TYPES, SHIFT_COLORS, TOTALS_COLOR, ALLOWED_FIXED_ASSIGNMENT_SHIFTS } from '@/types';
import { cn } from "@/lib/utils";
import { format, parseISO, getDay, getDaysInMonth, addDays, subDays, startOfMonth, endOfMonth, isValid, getYear as getFullYear, getMonth } from 'date-fns';
import { es } from 'date-fns/locale';
import { CheckCircle, XCircle, AlertTriangle, Info, PlusCircle, Trash2, Edit, Save, Settings, ArrowLeft, Download, Upload, Zap } from 'lucide-react';
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useToast } from "@/hooks/use-toast";

// --- CSV Tokens ---
const HISTORY_CSV_HEADER_TOKEN = "HISTORIAL_MES_ANTERIOR_EMPLEADO_V1";
const EMPLOYEE_CONFIG_HEADER_TOKEN = "CONFIGURACION_EMPLEADOS_V1";
const HOLIDAYS_HEADER_TOKEN = "FERIADOS_V1";
const ABSENCES_HEADER_TOKEN = "AUSENCIAS_V1";
const CONFIG_TARGET_STAFFING_TOKEN = "CONFIGURACION_DOTACION_OBJETIVO_V1";
const CONFIG_CONSECUTIVITY_RULES_TOKEN = "CONFIGURACION_REGLAS_CONSECUTIVIDAD_V1";
const CONFIG_OPERATIONAL_RULES_TOKEN = "CONFIGURACION_REGLAS_OPERATIVAS_V1";
const CONFIG_NIGHT_SHIFT_TOKEN = "CONFIGURACION_TURNO_NOCHE_V1";

// --- Initial Data (Now defaults, user can modify or import) ---
const defaultInitialEmployees: Employee[] = [
    // This list can be initially empty or have some defaults,
    // but will be overwritten by CSV import if that feature is used.
];

const defaultAbsences: Absence[] = [];
const defaultHolidays: Holiday[] = [];

const CURRENT_YEAR = new Date().getFullYear();
const MONTHS = [
    { value: 1, label: 'Enero' }, { value: 2, label: 'Febrero' }, { value: 3, label: 'Marzo' },
    { value: 4, label: 'Abril' }, { value: 5, label: 'Mayo' }, { value: 6, label: 'Junio' },
    { value: 7, label: 'Julio' }, { value: 8, label: 'Agosto' }, { value: 9, label: 'Septiembre' },
    { value: 10, label: 'Octubre' }, { value: 11, label: 'Noviembre' }, { value: 12, label: 'Diciembre' }
];

const shiftTypeSchema = z.union([z.enum(SHIFT_TYPES as [string, ...string[]]), z.literal('NULL')]);

const fixedAssignmentSchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha debe ser YYYY-MM-DD"),
    shift: z.enum(ALLOWED_FIXED_ASSIGNMENT_SHIFTS as [string, ...string[]])
});

const employeePreferenceSchema = z.object({
    preferWeekendWork: z.boolean().optional(),
    fixedAssignments: z.array(fixedAssignmentSchema).optional(),
    fixedWorkShift: z.object({
        dayOfWeek: z.array(z.number().min(0).max(6)),
        shift: z.enum(Array.from(new Set([...ALLOWED_FIXED_ASSIGNMENT_SHIFTS, 'D', 'C', 'N'])) as [string, ...string[]])
    }).optional()
});

const employeeSchema = z.object({
    id: z.number().optional(),
    name: z.string().min(1, "Nombre es requerido"),
    eligibleWeekend: z.boolean(),
    preferences: employeePreferenceSchema.optional(),
});

const absenceSchema = z.object({
    id: z.number().optional(),
    employeeId: z.number({required_error: "Debe seleccionar un empleado"}).min(1, "Debe seleccionar un empleado"),
    type: z.enum(["LAO", "LM"]),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato debe ser YYYY-MM-DD"),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato debe ser YYYY-MM-DD"),
}).refine(data => data.endDate >= data.startDate, {
    message: "La fecha final debe ser igual o posterior a la fecha inicial",
    path: ["endDate"],
});

const holidaySchema = z.object({
    id: z.number().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato debe ser YYYY-MM-DD"),
    description: z.string().min(1, "Descripción es requerida"),
});

// Helper function for holiday date validation
function isHolidayDateValid(dateStr: string, currentYear: number | null, currentMonth: number | null): boolean {
    if (!currentYear || !currentMonth) return false;
    try {
        const holidayDate = parseISO(dateStr);
        if (!isValid(holidayDate)) return false;
        return getFullYear(holidayDate) === currentYear && getMonth(holidayDate) === currentMonth - 1;
    } catch {
        return false;
    }
}

// Helper function for absence date range validation (overlap)
function isAbsenceRangeValid(startDateStr: string, endDateStr: string, currentYear: number | null, currentMonth: number | null): boolean {
    if (!currentYear || !currentMonth) return false;
    try {
        const absenceStart = parseISO(startDateStr);
        const absenceEnd = parseISO(endDateStr);
        if (!isValid(absenceStart) || !isValid(absenceEnd)) return false;

        const periodStart = startOfMonth(new Date(currentYear, currentMonth - 1));
        const periodEnd = endOfMonth(new Date(currentYear, currentMonth - 1));

        return absenceStart <= periodEnd && absenceEnd >= periodStart;
    } catch {
        return false;
    }
}


// --- Component ---
export default function Home() {
  const [displayMode, setDisplayMode] = useState<'config' | 'viewing'>('config');
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [report, setReport] = useState<ValidationResult[]>([]);
  const [scheduleScore, setScheduleScore] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [isDateInitialized, setIsDateInitialized] = useState(false);

  // Night Shift Toggle
  const [isNightShiftEnabled, setIsNightShiftEnabled] = useState<boolean>(true);

  // Target Staffing State
  const [targetMWorkday, setTargetMWorkday] = useState<number>(3);
  const [targetTWorkday, setTargetTWorkday] = useState<number>(1);
  const [targetNWorkday, setTargetNWorkday] = useState<number>(1);
  const [targetMWeekendHoliday, setTargetMWeekendHoliday] = useState<number>(2);
  const [targetTWeekendHoliday, setTargetTWeekendHoliday] = useState<number>(1);
  const [targetNWeekendHoliday, setTargetNWeekendHoliday] = useState<number>(1);
  const { toast } = useToast();

  // Consecutive days rules state
  const [maxConsecutiveWork, setMaxConsecutiveWork] = useState<number>(6);
  const [maxConsecutiveRest, setMaxConsecutiveRest] = useState<number>(2);
  const [preferredConsecutiveWorkDays, setPreferredConsecutiveWorkDays] = useState<number>(4);
  const [preferredConsecutiveRestDays, setPreferredConsecutiveRestDays] = useState<number>(2);


  // Operational Rules State
  const [requiredDdWeekends, setRequiredDdWeekends] = useState<number>(1);
  const [minCoverageTPT, setMinCoverageTPT] = useState<number>(2);
  const [minCoverageM, setMinCoverageM] = useState<number>(1);
  const [minCoverageT, setMinCoverageT] = useState<number>(1);
  const [minCoverageN, setMinCoverageN] = useState<number>(1);


  useEffect(() => {
    const now = new Date();
    setSelectedMonth(now.getMonth() + 1);
    setSelectedYear(now.getFullYear());
    setIsDateInitialized(true);
  }, []);


  const [employees, setEmployees] = useState<Employee[]>(defaultInitialEmployees.map(emp => ({...emp, preferences: emp.preferences || {}})));
  const [absences, setAbsences] = useState<Absence[]>(defaultAbsences);
  const [holidays, setHolidays] = useState<Holiday[]>(defaultHolidays);
  const [historyInputs, setHistoryInputs] = useState<{ [employeeId: number]: { [date: string]: ShiftType | null } }>({});

  const [isEmployeeDialogOpen, setIsEmployeeDialogOpen] = useState(false);
  const [isAbsenceDialogOpen, setIsAbsenceDialogOpen] = useState(false);
  const [isHolidayDialogOpen, setIsHolidayDialogOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [editingAbsence, setEditingAbsence] = useState<Absence | null>(null);
  const [editingHoliday, setEditingHoliday] = useState<Holiday | null>(null);


    const employeeForm = useForm<z.infer<typeof employeeSchema>>({
        resolver: zodResolver(employeeSchema),
        defaultValues: { name: '', eligibleWeekend: true, preferences: { fixedAssignments: [], preferWeekendWork: false, fixedWorkShift: undefined } },
    });
    const { fields: fixedAssignmentsFields, append: appendFixedAssignment, remove: removeFixedAssignment } = useFieldArray({ control: employeeForm.control, name: "preferences.fixedAssignments" });


    const absenceForm = useForm<z.infer<typeof absenceSchema>>({
        resolver: zodResolver(absenceSchema),
        defaultValues: { employeeId: undefined, type: 'LAO', startDate: '', endDate: '' },
    });
     const holidayForm = useForm<z.infer<typeof holidaySchema>>({
        resolver: zodResolver(holidaySchema),
        defaultValues: { date: '', description: '' },
    });


  const handleAddEmployee = (data: z.infer<typeof employeeSchema>) => {
    setEmployees(prev => [...prev, { ...data, id: Date.now(), history: {}, preferences: data.preferences || {} }]);
    setIsEmployeeDialogOpen(false);
    employeeForm.reset();
  };

  const handleUpdateEmployee = (data: z.infer<typeof employeeSchema>) => {
    if (!editingEmployee) return;
    setEmployees(prev => prev.map(emp => emp.id === editingEmployee.id ? { ...emp, ...data, preferences: data.preferences || {} } : emp));
    setIsEmployeeDialogOpen(false);
    setEditingEmployee(null);
    employeeForm.reset();
  }

  const handleDeleteEmployee = (id: number) => {
    setEmployees(prev => prev.filter(emp => emp.id !== id));
    setAbsences(prev => prev.filter(a => a.employeeId !== id)); // Also remove absences for deleted employee
    setHistoryInputs(prev => {
        const newHist = {...prev};
        delete newHist[id];
        return newHist;
    })
  }

  const openEditEmployeeDialog = (employee: Employee) => {
      setEditingEmployee(employee);
      const prefs = employee.preferences || {};
      employeeForm.reset({
          name: employee.name,
          eligibleWeekend: employee.eligibleWeekend,
          preferences: {
              preferWeekendWork: prefs.preferWeekendWork ?? false,
              fixedAssignments: prefs.fixedAssignments ?? [],
              fixedWorkShift: prefs.fixedWorkShift
          }
      });
      setIsEmployeeDialogOpen(true);
  };


  const handleAddAbsence = (data: z.infer<typeof absenceSchema>) => {
    if (!selectedYear || !selectedMonth) {
        toast({ title: "Error", description: "Por favor, seleccione mes y año en la pantalla principal antes de agregar una ausencia.", variant: "destructive" });
        return;
    }
    if (!isAbsenceRangeValid(data.startDate, data.endDate, selectedYear, selectedMonth)) {
        absenceForm.setError("startDate", { type: "manual", message: "El rango de la ausencia no se superpone con el período seleccionado." });
        toast({ title: "Error de Validación", description: "El rango de la ausencia no se superpone con el mes y año seleccionados.", variant: "destructive" });
        return;
    }
    const newAbsence = { ...data, id: Date.now() };
    setAbsences(prev => [...prev, newAbsence]);

    if (schedule) {
        const newSchedule = JSON.parse(JSON.stringify(schedule)) as Schedule;
        const startDateAbs = parseISO(newAbsence.startDate);
        const endDateAbs = parseISO(newAbsence.endDate);

        newSchedule.days.forEach(day => {
            const currentDate = parseISO(day.date);
            if (currentDate >= startDateAbs && currentDate <= endDateAbs) {
                if (newSchedule.days.find(d => d.date === day.date)?.shifts[newAbsence.employeeId] !== undefined) {
                    newSchedule.days.find(d => d.date === day.date)!.shifts[newAbsence.employeeId] = newAbsence.type;
                }
            }
        });
        setSchedule(newSchedule);
        toast({
            title: "Ausencia Aplicada al Horario Visible",
            description: "La ausencia se ha reflejado en el horario. Usa 'Recalcular Totales y Validar' para actualizar las métricas.",
            variant: "default",
        });
        if (schedule) setDisplayMode('viewing');
    }

    setIsAbsenceDialogOpen(false);
    absenceForm.reset();
  };

   const openEditAbsenceDialog = (absence: Absence) => {
      setEditingAbsence(absence);
      absenceForm.reset({
          employeeId: absence.employeeId,
          type: absence.type,
          startDate: absence.startDate,
          endDate: absence.endDate
      });
      setIsAbsenceDialogOpen(true);
  };

   const handleUpdateAbsence = (data: z.infer<typeof absenceSchema>) => {
     if (!editingAbsence?.id) return;
     if (!selectedYear || !selectedMonth) {
        toast({ title: "Error", description: "Por favor, seleccione mes y año en la pantalla principal antes de modificar una ausencia.", variant: "destructive" });
        return;
    }
    if (!isAbsenceRangeValid(data.startDate, data.endDate, selectedYear, selectedMonth)) {
        absenceForm.setError("startDate", { type: "manual", message: "El rango de la ausencia no se superpone con el período seleccionado." });
        toast({ title: "Error de Validación", description: "El rango de la ausencia no se superpone con el mes y año seleccionados.", variant: "destructive" });
        return;
    }
     const updatedAbsence = { ...editingAbsence, ...data };
     setAbsences(prev => prev.map(a => a.id === editingAbsence.id ? updatedAbsence : a));

     if (schedule) {
        const newSchedule = JSON.parse(JSON.stringify(schedule)) as Schedule;
        const startDateAbs = parseISO(updatedAbsence.startDate);
        const endDateAbs = parseISO(updatedAbsence.endDate);
        const employeeIdForAbsence = updatedAbsence.employeeId;
        const absenceType = updatedAbsence.type;

        newSchedule.days.forEach(day => {
            const currentDate = parseISO(day.date);
            // First, revert any old absence effect if it was this one
            // This logic might be complex if shifts were manually changed after absence was applied
            // Simplification: just apply the new range. User might need to manually adjust if old range becomes free.

            if (currentDate >= startDateAbs && currentDate <= endDateAbs) {
                 if (newSchedule.days.find(d => d.date === day.date)?.shifts[employeeIdForAbsence] !== undefined) {
                    newSchedule.days.find(d => d.date === day.date)!.shifts[employeeIdForAbsence] = absenceType;
                }
            }
        });
        setSchedule(newSchedule);
        toast({
            title: "Ausencia Actualizada en Horario Visible",
            description: "La ausencia se ha reflejado en el horario. Usa 'Recalcular Totales y Validar' para actualizar las métricas.",
            variant: "default",
        });
        if (schedule) setDisplayMode('viewing');
    }

     setIsAbsenceDialogOpen(false);
     setEditingAbsence(null);
     absenceForm.reset();
   }

  const handleDeleteAbsence = (id: number) => {
      setAbsences(prev => prev.filter(a => a.id !== id));
      if (schedule) {
        toast({
            title: "Ausencia Eliminada",
            description: "La ausencia ha sido eliminada. Los turnos LAO/LM previamente marcados en el horario no se revierten automáticamente. Ajústalos manualmente si es necesario y recalcula.",
            variant: "default",
        });
    }
  };

  const handleAddHoliday = (data: z.infer<typeof holidaySchema>) => {
    if (!selectedYear || !selectedMonth) {
        toast({ title: "Error", description: "Por favor, seleccione mes y año en la pantalla principal antes de agregar un feriado.", variant: "destructive" });
        return;
    }
    if (!isHolidayDateValid(data.date, selectedYear, selectedMonth)) {
        holidayForm.setError("date", { type: "manual", message: "La fecha no corresponde al mes y año seleccionados." });
        toast({ title: "Error de Validación", description: "La fecha del feriado no corresponde al mes y año seleccionados.", variant: "destructive" });
        return;
    }
    setHolidays(prev => [...prev, { ...data, id: Date.now() }]);
    setIsHolidayDialogOpen(false);
    holidayForm.reset();
  };

    const openEditHolidayDialog = (holiday: Holiday) => {
        setEditingHoliday(holiday);
        holidayForm.reset({
            date: holiday.date,
            description: holiday.description
        });
        setIsHolidayDialogOpen(true);
    };

    const handleUpdateHoliday = (data: z.infer<typeof holidaySchema>) => {
        if (!editingHoliday?.id) return;
        if (!selectedYear || !selectedMonth) {
            toast({ title: "Error", description: "Por favor, seleccione mes y año en la pantalla principal antes de modificar un feriado.", variant: "destructive" });
            return;
        }
        if (!isHolidayDateValid(data.date, selectedYear, selectedMonth)) {
            holidayForm.setError("date", { type: "manual", message: "La fecha no corresponde al mes y año seleccionados." });
            toast({ title: "Error de Validación", description: "La fecha del feriado no corresponde al mes y año seleccionados.", variant: "destructive" });
            return;
        }
        setHolidays(prev => prev.map(h => h.id === editingHoliday.id ? { ...h, ...data } : h));
        setIsHolidayDialogOpen(false);
        setEditingHoliday(null);
        holidayForm.reset();
    }

  const handleDeleteHoliday = (id: number) => {
      setHolidays(prev => prev.filter(h => h.id !== id));
  };


  const getPreviousMonthDates = useCallback(() => {
    if (!selectedYear || !selectedMonth) return [];
    const firstDayCurrentMonth = new Date(selectedYear, selectedMonth - 1, 1);
    const lastDayPreviousMonth = subDays(firstDayCurrentMonth, 1);
    const firstDayPreviousMonthRelevant = subDays(lastDayPreviousMonth, 4);

    const dates: string[] = [];
    for (let i = 0; i < 5; i++) {
        dates.push(format(addDays(firstDayPreviousMonthRelevant, i), 'yyyy-MM-dd'));
    }
    return dates.sort();
  }, [selectedYear, selectedMonth]);

  const handleHistoryChange = (employeeId: number, date: string, value: string) => {
      const shift = value === '-' ? null : value as ShiftType;
      setHistoryInputs(prev => ({
          ...prev,
          [employeeId]: {
              ...prev[employeeId],
              [date]: shift
          }
      }));
  };

  const handleImportHistoryFromCSV = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (!text) {
        toast({ title: "Error", description: "No se pudo leer el archivo.", variant: "destructive" });
        return;
      }

      try {
        const lines = text.split(/\r\n|\n/).filter(line => line.trim() !== '');
        if (lines.length < 2) {
            throw new Error("El archivo CSV está vacío o no tiene datos de empleados.");
        }

        const header = lines[0].split(',');
        const employeeNameIndex = header.findIndex(h => h.trim().toLowerCase() === 'empleado');
        if (employeeNameIndex === -1) {
          throw new Error("Columna 'Empleado' no encontrada en el encabezado del CSV.");
        }

        let detectedCsvFirstShiftColIndex: number;
        const totalTIndex = header.findIndex(h => h.trim().toLowerCase() === 'total t');
        if (totalTIndex === -1) throw new Error("Columna 'Total T' no encontrada en CSV para detectar estructura.");

        if ((totalTIndex + 1) < header.length && header[totalTIndex + 1].trim().toLowerCase() === 'total n') {
            detectedCsvFirstShiftColIndex = totalTIndex + 2;
        } else {
            detectedCsvFirstShiftColIndex = totalTIndex + 1;
        }


        let loadedEmployees: Employee[] = [];
        const loadedHistoryInputs: { [employeeId: number]: { [date: string]: ShiftType | null } } = {};
        const previousDatesForHistory = getPreviousMonthDates();

        let employeesProcessedFromCsv = 0;
        let scheduleSectionEndIndex = lines.findIndex(line => line.toLowerCase().startsWith("total mañana"));
        if (scheduleSectionEndIndex === -1) scheduleSectionEndIndex = lines.length;


        for (let i = 1; i < scheduleSectionEndIndex; i++) {
          const lineContent = lines[i];
          const cells = lineContent.split(',');
          const employeeNameFromCSV = cells[employeeNameIndex]?.trim();

          if (!employeeNameFromCSV ||
              employeeNameFromCSV.toLowerCase().startsWith(HISTORY_CSV_HEADER_TOKEN.toLowerCase()) ||
              employeeNameFromCSV.toLowerCase().startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN.toLowerCase()) ||
              employeeNameFromCSV.toLowerCase().startsWith(HOLIDAYS_HEADER_TOKEN.toLowerCase()) ||
              employeeNameFromCSV.toLowerCase().startsWith(ABSENCES_HEADER_TOKEN.toLowerCase())
              ) {
            scheduleSectionEndIndex = i;
            break;
          }

          employeesProcessedFromCsv++;

          const newEmployee: Employee = {
              id: Date.now() + loadedEmployees.length,
              name: employeeNameFromCSV,
              eligibleWeekend: true,
              preferences: {},
              history: {},
          };
          loadedEmployees.push(newEmployee);


          if (previousDatesForHistory.length > 0) {
            const dailyShiftsFromCSV = cells.slice(detectedCsvFirstShiftColIndex);
            const numHistoryDaysToTake = previousDatesForHistory.length;

            const relevantShiftsFromCSV = dailyShiftsFromCSV.slice(-numHistoryDaysToTake);

            if (relevantShiftsFromCSV.length > 0) {
                if (!loadedHistoryInputs[newEmployee.id]) {
                    loadedHistoryInputs[newEmployee.id] = {};
                }
                previousDatesForHistory.forEach((dateStr, index) => {
                    if (index < relevantShiftsFromCSV.length) {
                        const shiftValue = relevantShiftsFromCSV[index]?.trim();
                        if (shiftValue === 'N' && !isNightShiftEnabled) {
                            loadedHistoryInputs[newEmployee.id][dateStr] = null;
                        } else if (shiftValue && SHIFT_TYPES.includes(shiftValue as ShiftType)) {
                            loadedHistoryInputs[newEmployee.id][dateStr] = shiftValue as ShiftType;
                        } else if (shiftValue === '' || shiftValue === '-') {
                            loadedHistoryInputs[newEmployee.id][dateStr] = null;
                        } else if (shiftValue) {
                            console.warn(`Turno inválido '${shiftValue}' para ${employeeNameFromCSV} en CSV. Se ignora para fecha ${dateStr}.`);
                        }
                    }
                });
            } else {
                 console.warn(`No se encontraron suficientes columnas de turnos en el CSV para ${employeeNameFromCSV} para los ${numHistoryDaysToTake} días de historial requeridos.`);
            }
          }
        }

        let employeeConfigLoaded = false;
        const employeeConfigStartIndex = lines.findIndex(line => line.startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN));
        if (employeeConfigStartIndex !== -1) {
            const configHeaderLine = lines[employeeConfigStartIndex];
            const configHeaderParts = configHeaderLine.split(';');
            const configDataHeaders = configHeaderParts.slice(1);

            const empNameIndexConfig = configDataHeaders.findIndex(h => h.trim() === 'Nombre');
            const eligFindeIndex = configDataHeaders.findIndex(h => h.trim() === 'ElegibleFindeDD');
            const prefFindeIndex = configDataHeaders.findIndex(h => h.trim() === 'PrefiereTrabajarFinde');
            const turnoFijoIndex = configDataHeaders.findIndex(h => h.trim() === 'TurnoFijoSemanal_JSON');
            const asignFijasIndex = configDataHeaders.findIndex(h => h.trim() === 'AsignacionesFijas_JSON');

            loadedEmployees = loadedEmployees.map(existingEmp => {
                let employeeConfigDataRow: string | undefined;
                for (let i = employeeConfigStartIndex + 1; i < lines.length; i++) {
                    const currentLineContent = lines[i];
                     if (!currentLineContent.trim() ||
                        currentLineContent.startsWith(HOLIDAYS_HEADER_TOKEN) ||
                        currentLineContent.startsWith(ABSENCES_HEADER_TOKEN) ||
                        currentLineContent.startsWith(HISTORY_CSV_HEADER_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_TARGET_STAFFING_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_NIGHT_SHIFT_TOKEN)
                       ) break;
                    const dataCells = currentLineContent.split(';');
                    const csvConfigEmpName = (empNameIndexConfig !== -1 && empNameIndexConfig < dataCells.length) ? dataCells[empNameIndexConfig]?.trim() : '';
                    if (csvConfigEmpName.toLowerCase() === existingEmp.name.toLowerCase()) {
                        employeeConfigDataRow = currentLineContent;
                        break;
                    }
                }

                if (employeeConfigDataRow) {
                    const cells = employeeConfigDataRow.split(';');
                    const updatedEmployee = {
                        ...existingEmp,
                        preferences: {
                            ...(existingEmp.preferences || {}),
                             fixedAssignments: [],
                        }
                    };

                    if (eligFindeIndex !== -1 && eligFindeIndex < cells.length && cells[eligFindeIndex]) {
                        updatedEmployee.eligibleWeekend = cells[eligFindeIndex].trim().toLowerCase() === 'true';
                    }

                    if (prefFindeIndex !== -1 && prefFindeIndex < cells.length && cells[prefFindeIndex]) {
                        updatedEmployee.preferences.preferWeekendWork = cells[prefFindeIndex].trim().toLowerCase() === 'true';
                    } else {
                        updatedEmployee.preferences.preferWeekendWork = false;
                    }

                    const jsonStringTurnoFijo = (turnoFijoIndex !== -1 && turnoFijoIndex < cells.length) ? cells[turnoFijoIndex]?.trim() : "";
                    if (jsonStringTurnoFijo && jsonStringTurnoFijo.toLowerCase() !== 'null' && jsonStringTurnoFijo !== "") {
                        try {
                            const parsedFixedWorkShift = JSON.parse(jsonStringTurnoFijo);
                            if (parsedFixedWorkShift && Array.isArray(parsedFixedWorkShift.dayOfWeek) && typeof parsedFixedWorkShift.shift === 'string') {
                                updatedEmployee.preferences.fixedWorkShift = parsedFixedWorkShift;
                            } else {
                                 console.warn("Parsed TurnoFijoSemanal_JSON has invalid structure for", existingEmp.name, jsonStringTurnoFijo);
                                 delete updatedEmployee.preferences.fixedWorkShift;
                            }
                        } catch (e) {
                            console.warn("Error parsing TurnoFijoSemanal_JSON for", existingEmp.name, jsonStringTurnoFijo, e);
                            delete updatedEmployee.preferences.fixedWorkShift;
                        }
                    } else {
                        delete updatedEmployee.preferences.fixedWorkShift;
                    }

                    const jsonStringAsignaciones = (asignFijasIndex !== -1 && asignFijasIndex < cells.length) ? cells[asignFijasIndex]?.trim() : "";
                     if (jsonStringAsignaciones && jsonStringAsignaciones.toLowerCase() !== 'null' && jsonStringAsignaciones !== "[]" && jsonStringAsignaciones !== "") {
                        try {
                            const parsedFixedAssignments = JSON.parse(jsonStringAsignaciones);
                            if (Array.isArray(parsedFixedAssignments)) {
                                updatedEmployee.preferences.fixedAssignments = parsedFixedAssignments;
                            } else {
                                console.warn("Parsed AsignacionesFijas_JSON is not an array for", existingEmp.name, jsonStringAsignaciones);
                                updatedEmployee.preferences.fixedAssignments = [];
                            }
                        } catch (e) {
                            console.warn("Error parsing AsignacionesFijas_JSON for", existingEmp.name, jsonStringAsignaciones, e);
                            updatedEmployee.preferences.fixedAssignments = [];
                        }
                    } else {
                         updatedEmployee.preferences.fixedAssignments = [];
                    }
                    return updatedEmployee;
                }
                return existingEmp;
            });
            employeeConfigLoaded = true;
        }

        let loadedHolidays: Holiday[] = [];
        let holidaysLoadedFromCsv = false;
        const holidaysStartIndex = lines.findIndex(line => line.startsWith(HOLIDAYS_HEADER_TOKEN));
        if (holidaysStartIndex !== -1) {
            for (let i = holidaysStartIndex + 1; i < lines.length; i++) {
                const currentLine = lines[i];
                if (!currentLine.trim() || currentLine.startsWith(ABSENCES_HEADER_TOKEN) || currentLine.startsWith(HISTORY_CSV_HEADER_TOKEN) || currentLine.startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN) || currentLine.startsWith(CONFIG_TARGET_STAFFING_TOKEN) || currentLine.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN) || currentLine.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN) || currentLine.startsWith(CONFIG_NIGHT_SHIFT_TOKEN)) break;
                const [date, ...descriptionParts] = currentLine.split(';');
                const description = descriptionParts.join(';').trim();
                if (date && description) {
                    loadedHolidays.push({ id: Date.now() + loadedHolidays.length, date: date.trim(), description: description });
                }
            }
            holidaysLoadedFromCsv = loadedHolidays.length > 0;
        }

        let loadedAbsences: Absence[] = [];
        let absencesLoadedFromCsv = false;
        const absencesStartIndex = lines.findIndex(line => line.startsWith(ABSENCES_HEADER_TOKEN));
        if (absencesStartIndex !== -1) {
            const absenceHeaderLine = lines[absencesStartIndex];
            const absenceHeaderParts = absenceHeaderLine.split(';');
            const absenceDataHeaders = absenceHeaderParts.slice(1);

            const empNameIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'NombreEmpleado');
            const typeIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'Tipo');
            const startDateIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'FechaInicio');
            const endDateIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'FechaFin');

            for (let i = absencesStartIndex + 1; i < lines.length; i++) {
                const currentLine = lines[i];
                 if (!currentLine.trim() || currentLine.startsWith(HISTORY_CSV_HEADER_TOKEN) || currentLine.startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN) || currentLine.startsWith(HOLIDAYS_HEADER_TOKEN) || currentLine.startsWith(CONFIG_TARGET_STAFFING_TOKEN) || currentLine.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN) || currentLine.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN) || currentLine.startsWith(CONFIG_NIGHT_SHIFT_TOKEN)) break;

                const absenceCells = currentLine.split(';');
                const csvEmpNameAbsence = (empNameIndexAbsence !== -1 && empNameIndexAbsence < absenceCells.length) ? absenceCells[empNameIndexAbsence]?.trim() : '';
                const type = (typeIndexAbsence !== -1 && typeIndexAbsence < absenceCells.length) ? absenceCells[typeIndexAbsence]?.trim() : '';
                const startDate = (startDateIndexAbsence !== -1 && startDateIndexAbsence < absenceCells.length) ? absenceCells[startDateIndexAbsence]?.trim() : '';
                const endDate = (endDateIndexAbsence !== -1 && endDateIndexAbsence < absenceCells.length) ? absenceCells[endDateIndexAbsence]?.trim() : '';

                const employeeForAbsence = loadedEmployees.find(e => e.name.toLowerCase() === csvEmpNameAbsence.toLowerCase());

                if (employeeForAbsence && type && startDate && endDate) {
                    loadedAbsences.push({
                        id: Date.now() + loadedAbsences.length,
                        employeeId: employeeForAbsence.id,
                        type: type as "LAO" | "LM",
                        startDate: startDate,
                        endDate: endDate,
                    });
                } else {
                    console.warn(`Ausencia no cargada desde CSV: Empleado ${csvEmpNameAbsence} no encontrado en la lista de empleados cargados, o datos de ausencia incompletos.`);
                }
            }
            absencesLoadedFromCsv = loadedAbsences.length > 0;
        }


        setEmployees(loadedEmployees);
        setHistoryInputs(loadedHistoryInputs);
        setAbsences(absencesLoadedFromCsv ? loadedAbsences : []);
        setHolidays(holidaysLoadedFromCsv ? loadedHolidays : []);

        // Load general configurations if present
        let generalConfigsLoadedMessages: string[] = [];

        const targetStaffingStartIndex = lines.findIndex(line => line.startsWith(CONFIG_TARGET_STAFFING_TOKEN));
        if (targetStaffingStartIndex !== -1 && (targetStaffingStartIndex + 1) < lines.length) {
            const dataLine = lines[targetStaffingStartIndex + 1];
            const values = dataLine.split(';');
            if (values.length === 6) {
                setTargetMWorkday(parseInt(values[0]) || 0);
                setTargetTWorkday(parseInt(values[1]) || 0);
                setTargetNWorkday(parseInt(values[2]) || 0);
                setTargetMWeekendHoliday(parseInt(values[3]) || 0);
                setTargetTWeekendHoliday(parseInt(values[4]) || 0);
                setTargetNWeekendHoliday(parseInt(values[5]) || 0);
                generalConfigsLoadedMessages.push("Dotación Objetivo cargada.");
            }
        }

        const consecutivityRulesStartIndex = lines.findIndex(line => line.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN));
        if (consecutivityRulesStartIndex !== -1 && (consecutivityRulesStartIndex + 1) < lines.length) {
            const dataLine = lines[consecutivityRulesStartIndex + 1];
            const values = dataLine.split(';');
            if (values.length >= 2) { // Allow for 2 or 4 values for backward/forward compatibility
                setMaxConsecutiveWork(parseInt(values[0]) || 1);
                setMaxConsecutiveRest(parseInt(values[1]) || 1);
                if (values.length === 4) {
                    setPreferredConsecutiveWorkDays(parseInt(values[2]) || 1);
                    setPreferredConsecutiveRestDays(parseInt(values[3]) || 1);
                } else { // If old format, set preferred to max
                    setPreferredConsecutiveWorkDays(parseInt(values[0]) || 1);
                    setPreferredConsecutiveRestDays(parseInt(values[1]) || 1);
                }
                generalConfigsLoadedMessages.push("Reglas Consecutividad cargadas.");
            }
        }

        const operationalRulesStartIndex = lines.findIndex(line => line.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN));
        if (operationalRulesStartIndex !== -1 && (operationalRulesStartIndex + 1) < lines.length) {
            const dataLine = lines[operationalRulesStartIndex + 1];
            const values = dataLine.split(';');
             if (values.length === 5) {
                setRequiredDdWeekends(parseInt(values[0]) || 0);
                setMinCoverageTPT(parseInt(values[1]) || 0);
                setMinCoverageM(parseInt(values[2]) || 0);
                setMinCoverageT(parseInt(values[3]) || 0);
                setMinCoverageN(parseInt(values[4]) || 0);
                generalConfigsLoadedMessages.push("Reglas Operativas cargadas.");
            }
        }

        const nightShiftConfigStartIndex = lines.findIndex(line => line.startsWith(CONFIG_NIGHT_SHIFT_TOKEN));
        if (nightShiftConfigStartIndex !== -1 && (nightShiftConfigStartIndex + 1) < lines.length) {
            const dataLine = lines[nightShiftConfigStartIndex + 1];
            const values = dataLine.split(';');
            if (values.length === 1) {
                setIsNightShiftEnabled(values[0].trim().toLowerCase() === 'true');
                generalConfigsLoadedMessages.push("Config. Turno Noche cargada.");
            }
        }


        let toastMessage = "";
        if (loadedEmployees.length > 0) {
            const historyMsg = previousDatesForHistory.length > 0 ? ` Historial importado.` : "";
            const empConfigMsg = employeeConfigLoaded ? " Config. empleados cargada." : "";
            const holidaysMsg = holidaysLoadedFromCsv ? ` ${loadedHolidays.length} feriado(s) cargado(s).` : "";
            const absencesMsg = absencesLoadedFromCsv ? ` ${loadedAbsences.length} ausencia(s) cargada(s).` : "";
            const generalConfigMsg = generalConfigsLoadedMessages.length > 0 ? ` ${generalConfigsLoadedMessages.join(' ')}` : "";
            toastMessage = `${loadedEmployees.length} empleado(s) cargado(s).${historyMsg}${empConfigMsg}${holidaysMsg}${absencesMsg}${generalConfigMsg}`;
            toast({ title: "Importación Exitosa", description: toastMessage });
        } else if (employeesProcessedFromCsv > 0) {
             toastMessage = `Se procesaron ${employeesProcessedFromCsv} filas de empleados del CSV, pero no se cargaron nuevos empleados (posiblemente duplicados o formato incorrecto).`;
             toast({ title: "Importación Parcial", description: toastMessage, variant: "default" });
        } else {
            toastMessage = "No se encontraron datos de empleados válidos en el archivo CSV para cargar.";
            toast({ title: "Sin Empleados Cargados", description: toastMessage, variant: "default" });
        }

      } catch (error) {
        console.error("Error importando CSV:", error);
        toast({ title: "Error de Importación", description: error instanceof Error ? error.message : "Ocurrió un error procesando el archivo CSV.", variant: "destructive" });
      }
    };

    reader.onerror = () => {
      toast({ title: "Error", description: "No se pudo leer el archivo.", variant: "destructive" });
    };

    reader.readAsText(file);

    if (event.target) {
      event.target.value = '';
    }
  };

  const handleLoadFullScheduleFromCSV = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedMonth || !selectedYear || !isDateInitialized) {
      toast({ title: "Error", description: "Seleccione mes y año antes de cargar un horario.", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (!text) {
        toast({ title: "Error", description: "No se pudo leer el archivo.", variant: "destructive" });
        setIsLoading(false);
        return;
      }

      try {
        const lines = text.split(/\r\n|\n/).filter(line => line.trim() !== '');
        if (lines.length < 2) throw new Error("El CSV está vacío o no tiene suficientes filas.");

        const headerCells = lines[0].split(',');
        const employeeNameColIndex = headerCells.findIndex(h => h.trim().toLowerCase() === 'empleado');
        if (employeeNameColIndex === -1) throw new Error("Columna 'Empleado' no encontrada en el CSV.");

        let detectedCsvFirstShiftColIndex: number;
        const totalTIndex = headerCells.findIndex(h => h.trim().toLowerCase() === 'total t');
        if (totalTIndex === -1) throw new Error("Columna 'Total T' no encontrada en el encabezado del CSV. Formato de archivo no reconocido.");

        if ((totalTIndex + 1) < headerCells.length && headerCells[totalTIndex + 1].trim().toLowerCase() === 'total n') {
            detectedCsvFirstShiftColIndex = totalTIndex + 2;
        } else {
            detectedCsvFirstShiftColIndex = totalTIndex + 1;
        }

        const daysInSelectedMonth = getDaysInMonth(new Date(selectedYear, selectedMonth - 1));
        const allPotentialDayHeadersInCsv = headerCells.slice(detectedCsvFirstShiftColIndex);

        if (allPotentialDayHeadersInCsv.length < daysInSelectedMonth) {
            throw new Error(`El número de columnas de días en el CSV (${allPotentialDayHeadersInCsv.length}) es menor que los días del mes seleccionado (${daysInSelectedMonth}). Asegúrese que el mes y año seleccionado coincidan con el contenido del archivo CSV.`);
        }

        const loadedEmployeesFromMainSchedule: Employee[] = [];
        const newSchedule = initializeScheduleLib(selectedYear, selectedMonth, [], holidays, isNightShiftEnabled); // Temporarily pass empty employees

        let scheduleSectionEndIndex = lines.findIndex(line => line.toLowerCase().startsWith("total mañana"));
        if (scheduleSectionEndIndex === -1) scheduleSectionEndIndex = lines.length;

        for (let i = 1; i < scheduleSectionEndIndex; i++) {
            const lineContent = lines[i];
            const cells = lineContent.split(',');
            const csvEmployeeName = cells[employeeNameColIndex]?.trim();
            if (!csvEmployeeName || csvEmployeeName.toLowerCase().startsWith(HISTORY_CSV_HEADER_TOKEN.toLowerCase()) || csvEmployeeName.toLowerCase().startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN.toLowerCase()) || csvEmployeeName.toLowerCase().startsWith(HOLIDAYS_HEADER_TOKEN.toLowerCase()) || csvEmployeeName.toLowerCase().startsWith(ABSENCES_HEADER_TOKEN.toLowerCase())) {
                 scheduleSectionEndIndex = i;
                 break;
            }


            const newEmployee: Employee = {
                id: Date.now() + loadedEmployeesFromMainSchedule.length,
                name: csvEmployeeName,
                eligibleWeekend: true,
                preferences: {},
                history: {}
            };
            loadedEmployeesFromMainSchedule.push(newEmployee);
            newSchedule.employeeTotals[newEmployee.id] = { M: 0, T: 0, N: 0, D: 0, F: 0, LM: 0, LAO: 0, C: 0, workedDays: 0, freeSaturdays: 0, freeSundays: 0 };


            for (let dayIdx = 0; dayIdx < daysInSelectedMonth; dayIdx++) {
              const csvShiftCellIndex = detectedCsvFirstShiftColIndex + dayIdx;
              if (csvShiftCellIndex >= cells.length) {
                  console.warn(`Fila de datos para empleado ${csvEmployeeName} es más corta de lo esperado. Faltan datos para el día ${dayIdx + 1}`);
                  newSchedule.days[dayIdx].shifts[newEmployee.id] = null;
                  continue;
              }
              const csvShift = cells[csvShiftCellIndex]?.trim();

              if (csvShift === 'N' && !isNightShiftEnabled) { // Use current UI state for night shift filter
                newSchedule.days[dayIdx].shifts[newEmployee.id] = null;
              } else if (csvShift && SHIFT_TYPES.includes(csvShift as ShiftType)) {
                newSchedule.days[dayIdx].shifts[newEmployee.id] = csvShift as ShiftType;
              } else if (csvShift === '' || csvShift === '-') {
                newSchedule.days[dayIdx].shifts[newEmployee.id] = null;
              }
            }
        }
        let currentEmployees = [...loadedEmployeesFromMainSchedule];


        let employeeConfigLoaded = false;
        const employeeConfigStartIndex = lines.findIndex(line => line.startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN));
        if (employeeConfigStartIndex !== -1) {
            const configHeaderLine = lines[employeeConfigStartIndex];
            const configHeaderParts = configHeaderLine.split(';');
            const configDataHeaders = configHeaderParts.slice(1);

            const empNameIndexConfig = configDataHeaders.findIndex(h => h.trim() === 'Nombre');
            const eligFindeIndex = configDataHeaders.findIndex(h => h.trim() === 'ElegibleFindeDD');
            const prefFindeIndex = configDataHeaders.findIndex(h => h.trim() === 'PrefiereTrabajarFinde');
            const turnoFijoIndex = configDataHeaders.findIndex(h => h.trim() === 'TurnoFijoSemanal_JSON');
            const asignFijasIndex = configDataHeaders.findIndex(h => h.trim() === 'AsignacionesFijas_JSON');

            currentEmployees = currentEmployees.map(existingEmp => {
                let employeeConfigDataRow: string | undefined;
                for (let i = employeeConfigStartIndex + 1; i < lines.length; i++) {
                    const currentLineContent = lines[i];
                     if (!currentLineContent.trim() ||
                        currentLineContent.startsWith(HOLIDAYS_HEADER_TOKEN) ||
                        currentLineContent.startsWith(ABSENCES_HEADER_TOKEN) ||
                        currentLineContent.startsWith(HISTORY_CSV_HEADER_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_TARGET_STAFFING_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN) ||
                        currentLineContent.startsWith(CONFIG_NIGHT_SHIFT_TOKEN)
                       ) break;
                    const dataCells = currentLineContent.split(';');
                    const csvConfigEmpName = (empNameIndexConfig !== -1 && empNameIndexConfig < dataCells.length) ? dataCells[empNameIndexConfig]?.trim() : '';
                    if (csvConfigEmpName.toLowerCase() === existingEmp.name.toLowerCase()) {
                        employeeConfigDataRow = currentLineContent;
                        break;
                    }
                }

                if (employeeConfigDataRow) {
                    const cells = employeeConfigDataRow.split(';');
                    const updatedEmployee = {
                        ...existingEmp,
                        preferences: {
                            ...(existingEmp.preferences || {}),
                             fixedAssignments: [],
                        }
                    };

                    if (eligFindeIndex !== -1 && eligFindeIndex < cells.length && cells[eligFindeIndex]) {
                        updatedEmployee.eligibleWeekend = cells[eligFindeIndex].trim().toLowerCase() === 'true';
                    }

                    if (prefFindeIndex !== -1 && prefFindeIndex < cells.length && cells[prefFindeIndex]) {
                        updatedEmployee.preferences.preferWeekendWork = cells[prefFindeIndex].trim().toLowerCase() === 'true';
                    } else {
                        updatedEmployee.preferences.preferWeekendWork = false;
                    }

                    const jsonStringTurnoFijo = (turnoFijoIndex !== -1 && turnoFijoIndex < cells.length) ? cells[turnoFijoIndex]?.trim() : "";
                    if (jsonStringTurnoFijo && jsonStringTurnoFijo.toLowerCase() !== 'null' && jsonStringTurnoFijo !== "") {
                        try {
                            const parsedFixedWorkShift = JSON.parse(jsonStringTurnoFijo);
                            if (parsedFixedWorkShift && Array.isArray(parsedFixedWorkShift.dayOfWeek) && typeof parsedFixedWorkShift.shift === 'string') {
                                updatedEmployee.preferences.fixedWorkShift = parsedFixedWorkShift;
                            } else {
                                 console.warn("Parsed TurnoFijoSemanal_JSON has invalid structure for", existingEmp.name, jsonStringTurnoFijo);
                                 delete updatedEmployee.preferences.fixedWorkShift;
                            }
                        } catch (e) {
                            console.warn("Error parsing TurnoFijoSemanal_JSON for", existingEmp.name, jsonStringTurnoFijo, e);
                            delete updatedEmployee.preferences.fixedWorkShift;
                        }
                    } else {
                        delete updatedEmployee.preferences.fixedWorkShift;
                    }

                    const jsonStringAsignaciones = (asignFijasIndex !== -1 && asignFijasIndex < cells.length) ? cells[asignFijasIndex]?.trim() : "";
                     if (jsonStringAsignaciones && jsonStringAsignaciones.toLowerCase() !== 'null' && jsonStringAsignaciones !== "[]" && jsonStringAsignaciones !== "") {
                        try {
                            const parsedFixedAssignments = JSON.parse(jsonStringAsignaciones);
                            if (Array.isArray(parsedFixedAssignments)) {
                                updatedEmployee.preferences.fixedAssignments = parsedFixedAssignments;
                            } else {
                                console.warn("Parsed AsignacionesFijas_JSON is not an array for", existingEmp.name, jsonStringAsignaciones);
                                updatedEmployee.preferences.fixedAssignments = [];
                            }
                        } catch (e) {
                            console.warn("Error parsing AsignacionesFijas_JSON for", existingEmp.name, jsonStringAsignaciones, e);
                            updatedEmployee.preferences.fixedAssignments = [];
                        }
                    } else {
                         updatedEmployee.preferences.fixedAssignments = [];
                    }
                    return updatedEmployee;
                }
                return existingEmp;
            });
            employeeConfigLoaded = true;
        }



        let historyLoaded = false;
        const newHistoryInputs: { [employeeId: number]: { [date: string]: ShiftType | null } } = {};
        const historySectionStartIndex = lines.findIndex(line => line.startsWith(HISTORY_CSV_HEADER_TOKEN));

        if (historySectionStartIndex !== -1) {
            const historyHeaderLine = lines[historySectionStartIndex];
            const historyHeaderCells = historyHeaderLine.split(';');
            const historyDateHeaders = historyHeaderCells.slice(1).map(h => h.trim()); // Dates start after the token

            for (let i = historySectionStartIndex + 1; i < lines.length; i++) {
                const historyLineContent = lines[i];
                 if (!historyLineContent.trim() ||
                    historyLineContent.toLowerCase().startsWith("total") || // Catches "Total Mañana", etc.
                    historyLineContent.startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN) ||
                    historyLineContent.startsWith(HOLIDAYS_HEADER_TOKEN) ||
                    historyLineContent.startsWith(ABSENCES_HEADER_TOKEN) ||
                    historyLineContent.startsWith(CONFIG_TARGET_STAFFING_TOKEN) ||
                    historyLineContent.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN) ||
                    historyLineContent.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN) ||
                    historyLineContent.startsWith(CONFIG_NIGHT_SHIFT_TOKEN)
                    ) break;

                const historyCells = historyLineContent.split(','); // History data is comma separated
                const csvEmployeeName = historyCells[0]?.trim(); // Employee name is the first cell
                const employeeInApp = currentEmployees.find(emp => emp.name.trim().toLowerCase() === csvEmployeeName.toLowerCase());

                if (employeeInApp) {
                    if (!newHistoryInputs[employeeInApp.id]) {
                        newHistoryInputs[employeeInApp.id] = {};
                    }
                    historyDateHeaders.forEach((dateStr, index) => {
                        const shiftValue = historyCells[index + 1]?.trim(); // Shifts start from second cell
                        if (shiftValue === 'N' && !isNightShiftEnabled) { // Use current UI state for filtering N
                             newHistoryInputs[employeeInApp.id][dateStr] = null;
                        } else if (dateStr && (SHIFT_TYPES.includes(shiftValue as ShiftType) || shiftValue === '' || shiftValue === '-')) {
                            newHistoryInputs[employeeInApp.id][dateStr] = (shiftValue === '' || shiftValue === '-') ? null : shiftValue as ShiftType;
                        }
                    });
                }
            }
            setHistoryInputs(newHistoryInputs);
            historyLoaded = Object.keys(newHistoryInputs).length > 0;
        }


        let holidaysLoaded = false;
        const newHolidays: Holiday[] = [];
        const holidaysStartIndex = lines.findIndex(line => line.startsWith(HOLIDAYS_HEADER_TOKEN));
        if (holidaysStartIndex !== -1) {
            for (let i = holidaysStartIndex + 1; i < lines.length; i++) {
                const currentLine = lines[i];
                if (!currentLine.trim() || currentLine.startsWith(ABSENCES_HEADER_TOKEN) || currentLine.startsWith(HISTORY_CSV_HEADER_TOKEN) || currentLine.startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN) || currentLine.startsWith(CONFIG_TARGET_STAFFING_TOKEN) || currentLine.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN) || currentLine.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN) || currentLine.startsWith(CONFIG_NIGHT_SHIFT_TOKEN)) break;
                const [date, ...descriptionParts] = currentLine.split(';');
                const description = descriptionParts.join(';').trim();
                if (date && description) {
                    newHolidays.push({ id: Date.now() + newHolidays.length, date: date.trim(), description: description });
                }
            }
            setHolidays(newHolidays);
            holidaysLoaded = newHolidays.length > 0;
        }


        let absencesLoaded = false;
        const newAbsences: Absence[] = [];
        const absencesStartIndex = lines.findIndex(line => line.startsWith(ABSENCES_HEADER_TOKEN));
        if (absencesStartIndex !== -1) {
            const absenceHeaderLine = lines[absencesStartIndex];
            const absenceHeaderParts = absenceHeaderLine.split(';');
            const absenceDataHeaders = absenceHeaderParts.slice(1);

            const empNameIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'NombreEmpleado');
            const typeIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'Tipo');
            const startDateIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'FechaInicio');
            const endDateIndexAbsence = absenceDataHeaders.findIndex(h => h.trim() === 'FechaFin');


            for (let i = absencesStartIndex + 1; i < lines.length; i++) {
                const currentLine = lines[i];
                 if (!currentLine.trim() || currentLine.startsWith(HISTORY_CSV_HEADER_TOKEN) || currentLine.startsWith(EMPLOYEE_CONFIG_HEADER_TOKEN) || currentLine.startsWith(HOLIDAYS_HEADER_TOKEN) || currentLine.startsWith(CONFIG_TARGET_STAFFING_TOKEN) || currentLine.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN) || currentLine.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN) || currentLine.startsWith(CONFIG_NIGHT_SHIFT_TOKEN)) break;

                const absenceCells = currentLine.split(';');
                const csvEmpNameAbsence = (empNameIndexAbsence !== -1 && empNameIndexAbsence < absenceCells.length) ? absenceCells[empNameIndexAbsence]?.trim() : '';
                const type = (typeIndexAbsence !== -1 && typeIndexAbsence < absenceCells.length) ? absenceCells[typeIndexAbsence]?.trim() : '';
                const startDate = (startDateIndexAbsence !== -1 && startDateIndexAbsence < absenceCells.length) ? absenceCells[startDateIndexAbsence]?.trim() : '';
                const endDate = (endDateIndexAbsence !== -1 && endDateIndexAbsence < absenceCells.length) ? absenceCells[endDateIndexAbsence]?.trim() : '';

                const employeeForAbsence = currentEmployees.find(e => e.name.toLowerCase() === csvEmpNameAbsence.toLowerCase());

                if (employeeForAbsence && type && startDate && endDate) {
                    newAbsences.push({
                        id: Date.now() + newAbsences.length,
                        employeeId: employeeForAbsence.id,
                        type: type as "LAO" | "LM",
                        startDate: startDate,
                        endDate: endDate,
                    });
                } else {
                    console.warn(`Ausencia no cargada: Empleado ${csvEmpNameAbsence} no encontrado, o datos de ausencia incompletos.`);
                }
            }
            setAbsences(newAbsences);
            absencesLoaded = newAbsences.length > 0;
        }

        let targetStaffingLoaded = false;
        const targetStaffingStartIndex = lines.findIndex(line => line.startsWith(CONFIG_TARGET_STAFFING_TOKEN));
        if (targetStaffingStartIndex !== -1 && (targetStaffingStartIndex + 1) < lines.length) {
            const dataLine = lines[targetStaffingStartIndex + 1];
            const values = dataLine.split(';');
            if (values.length === 6) {
                setTargetMWorkday(parseInt(values[0]) || 0);
                setTargetTWorkday(parseInt(values[1]) || 0);
                setTargetNWorkday(parseInt(values[2]) || 0);
                setTargetMWeekendHoliday(parseInt(values[3]) || 0);
                setTargetTWeekendHoliday(parseInt(values[4]) || 0);
                setTargetNWeekendHoliday(parseInt(values[5]) || 0);
                targetStaffingLoaded = true;
            }
        }

        let consecutivityRulesLoaded = false;
        const consecutivityRulesStartIndex = lines.findIndex(line => line.startsWith(CONFIG_CONSECUTIVITY_RULES_TOKEN));
        if (consecutivityRulesStartIndex !== -1 && (consecutivityRulesStartIndex + 1) < lines.length) {
            const dataLine = lines[consecutivityRulesStartIndex + 1];
            const values = dataLine.split(';');
            if (values.length >= 2) { // Allow for 2 or 4 values
                setMaxConsecutiveWork(parseInt(values[0]) || 1);
                setMaxConsecutiveRest(parseInt(values[1]) || 1);
                if (values.length === 4) {
                    setPreferredConsecutiveWorkDays(parseInt(values[2]) || 1);
                    setPreferredConsecutiveRestDays(parseInt(values[3]) || 1);
                } else { // If old format, set preferred to max
                    setPreferredConsecutiveWorkDays(parseInt(values[0]) || 1);
                    setPreferredConsecutiveRestDays(parseInt(values[1]) || 1);
                }
                consecutivityRulesLoaded = true;
            }
        }

        let operationalRulesLoaded = false;
        const operationalRulesStartIndex = lines.findIndex(line => line.startsWith(CONFIG_OPERATIONAL_RULES_TOKEN));
        if (operationalRulesStartIndex !== -1 && (operationalRulesStartIndex + 1) < lines.length) {
            const dataLine = lines[operationalRulesStartIndex + 1];
            const values = dataLine.split(';');
             if (values.length === 5) {
                setRequiredDdWeekends(parseInt(values[0]) || 0);
                setMinCoverageTPT(parseInt(values[1]) || 0);
                setMinCoverageM(parseInt(values[2]) || 0);
                setMinCoverageT(parseInt(values[3]) || 0);
                setMinCoverageN(parseInt(values[4]) || 0);
                operationalRulesLoaded = true;
            }
        }

        let nightShiftConfigLoaded = false;
        let loadedIsNightShiftEnabled = isNightShiftEnabled; // Default to current UI state

        const nightShiftConfigStartIndex = lines.findIndex(line => line.startsWith(CONFIG_NIGHT_SHIFT_TOKEN));
        if (nightShiftConfigStartIndex !== -1 && (nightShiftConfigStartIndex + 1) < lines.length) {
            const dataLine = lines[nightShiftConfigStartIndex + 1];
            const values = dataLine.split(';');
            if (values.length === 1) {
                loadedIsNightShiftEnabled = values[0].trim().toLowerCase() === 'true';
                setIsNightShiftEnabled(loadedIsNightShiftEnabled); // Update UI state
                nightShiftConfigLoaded = true;
            }
        }


        if (currentEmployees.length === 0) {
          throw new Error("No se encontraron empleados válidos en la sección principal del horario del CSV.");
        }
        setEmployees(currentEmployees);


        const currentTargetStaffing: TargetStaffing = {
          workdayMorning: targetMWorkday,
          workdayAfternoon: targetTWorkday,
          workdayNight: loadedIsNightShiftEnabled ? targetNWorkday : 0,
          weekendHolidayMorning: targetMWeekendHoliday,
          weekendHolidayAfternoon: targetTWeekendHoliday,
          weekendHolidayNight: loadedIsNightShiftEnabled ? targetNWeekendHoliday : 0,
        };
        const currentOperationalRules: OperationalRules = {
            requiredDdWeekends: requiredDdWeekends,
            minCoverageTPT: minCoverageTPT,
            minCoverageM: minCoverageM,
            minCoverageT: minCoverageT,
            minCoverageN: loadedIsNightShiftEnabled ? minCoverageN : 0,
        };

        calculateFinalTotals(newSchedule, currentEmployees, newAbsences, loadedIsNightShiftEnabled);
        const newReport = validateSchedule(
            newSchedule,
            currentEmployees,
            newAbsences,
            newHolidays,
            currentTargetStaffing,
            maxConsecutiveWork,
            maxConsecutiveRest,
            currentOperationalRules,
            loadedIsNightShiftEnabled,
            preferredConsecutiveWorkDays,
            preferredConsecutiveRestDays
        );

        setSchedule(newSchedule);
        setReport(newReport);
        setScheduleScore(calculateScheduleScore(newReport));
        setDisplayMode('viewing');
        let toastMessages = [`Horario cargado para ${currentEmployees.length} empleado(s).`];
        if (employeeConfigLoaded) toastMessages.push("Config. empleados cargada.");
        if (historyLoaded) toastMessages.push("Historial cargado.");
        if (holidaysLoaded) toastMessages.push(`${newHolidays.length} feriado(s) cargado(s).`);
        if (absencesLoaded) toastMessages.push(`${newAbsences.length} ausencia(s) cargada(s).`);
        if (targetStaffingLoaded) toastMessages.push("Dotación objetivo cargada.");
        if (consecutivityRulesLoaded) toastMessages.push("Reglas consecutividad cargadas.");
        if (operationalRulesLoaded) toastMessages.push("Reglas operativas cargadas.");
        if (nightShiftConfigLoaded) toastMessages.push("Config. turno noche cargada.");

        toast({ title: "Horario Cargado Completamente", description: toastMessages.join(' ') });


      } catch (error) {
        console.error("Error importando horario completo desde CSV:", error);
        toast({ title: "Error de Importación", description: error instanceof Error ? error.message : "Ocurrió un error procesando el archivo CSV del horario.", variant: "destructive" });
        setSchedule(null);
        setReport([]);
        setScheduleScore(null);
      } finally {
        setIsLoading(false);
      }
    };
    reader.onerror = () => {
      toast({ title: "Error", description: "No se pudo leer el archivo.", variant: "destructive" });
      setIsLoading(false);
    };
    reader.readAsText(file);
     if (event.target) {
      event.target.value = '';
    }
  };


  const handleGenerateSchedule = () => {
    if (!isDateInitialized || selectedMonth === null || selectedYear === null) {
        toast({ title: "Error", description: "Por favor, seleccione mes y año antes de generar el horario.", variant: "destructive" });
        return;
    }
    if (employees.length === 0) {
        toast({ title: "Error de Configuración", description: "No hay empleados definidos. Por favor, agregue empleados o impórtelos desde un CSV.", variant: "destructive" });
        setDisplayMode('config');
        setCurrentStep(1);
        return;
    }
    setIsLoading(true);
    setSchedule(null); // Reset schedule before generation
    setReport([]);
    setScheduleScore(null);


    const employeesWithHistory = employees.map(emp => ({
      ...emp,
      history: historyInputs[emp.id] || {},
      consecutiveWorkDays: 0
    }));


     if (employeesWithHistory.length === 0) {
       setReport([{ rule: "Error de Entrada", passed: false, details: "No hay empleados definidos." }]);
       setIsLoading(false);
       setDisplayMode('viewing');
       return;
     }
     if (isNaN(selectedYear) || isNaN(selectedMonth) || selectedMonth < 1 || selectedMonth > 12) {
         setReport([{ rule: "Error de Entrada", passed: false, details: "Mes o año inválido." }]);
         setIsLoading(false);
         setDisplayMode('viewing');
         return;
     }

    const currentTargetStaffing: TargetStaffing = {
        workdayMorning: targetMWorkday,
        workdayAfternoon: targetTWorkday,
        workdayNight: isNightShiftEnabled ? targetNWorkday : 0,
        weekendHolidayMorning: targetMWeekendHoliday,
        weekendHolidayAfternoon: targetTWeekendHoliday,
        weekendHolidayNight: isNightShiftEnabled ? targetNWeekendHoliday : 0,
    };
    const currentOperationalRules: OperationalRules = {
        requiredDdWeekends: requiredDdWeekends,
        minCoverageTPT: minCoverageTPT,
        minCoverageM: minCoverageM,
        minCoverageT: minCoverageT,
        minCoverageN: isNightShiftEnabled ? minCoverageN : 0,
    };

    setTimeout(() => {
      try {
        const result = generateSchedule(
          selectedYear,
          selectedMonth,
          JSON.parse(JSON.stringify(employeesWithHistory)),
          JSON.parse(JSON.stringify(absences)),
          JSON.parse(JSON.stringify(holidays)),
          currentTargetStaffing,
          maxConsecutiveWork,
          maxConsecutiveRest,
          currentOperationalRules,
          isNightShiftEnabled,
          preferredConsecutiveWorkDays,
          preferredConsecutiveRestDays
        );
        setSchedule(result.schedule);
        setReport(result.report);
        setScheduleScore(calculateScheduleScore(result.report));
        setDisplayMode('viewing');
      } catch (error) {
        console.error("Error generating schedule:", error);
        setReport([{rule: "Error de Generación", passed: false, details: `Error inesperado: ${error instanceof Error ? error.message : 'Error desconocido'}`}]);
        setScheduleScore(0);
        setDisplayMode('viewing');
      } finally {
        setIsLoading(false);
      }
    }, 50);
  };

    const handleManualShiftChange = (employeeId: number, date: string, newShiftValue: string | null) => {
        if (!schedule) return;

        const newShift = newShiftValue === 'NULL' ? null : newShiftValue as ShiftType;
        const updatedSchedule: Schedule = JSON.parse(JSON.stringify(schedule));
        const dayIndex = updatedSchedule.days.findIndex(d => d.date === date);
        if (dayIndex !== -1) {
            updatedSchedule.days[dayIndex].shifts[employeeId] = newShift;
            setSchedule(updatedSchedule);
            setReport([]);
            setScheduleScore(null);
        }
    };

    const handleRecalculate = () => {
        if (!schedule) return;
        if (!selectedYear || !selectedMonth) {
            toast({ title: "Error", description: "Mes y año no seleccionados para recalcular.", variant: "destructive" });
            return;
        }
        setIsLoading(true);
        setReport([]);
        setScheduleScore(null);
         const scheduleToRecalculate = JSON.parse(JSON.stringify(schedule));
         const currentTargetStaffing: TargetStaffing = {
            workdayMorning: targetMWorkday,
            workdayAfternoon: targetTWorkday,
            workdayNight: isNightShiftEnabled ? targetNWorkday : 0,
            weekendHolidayMorning: targetMWeekendHoliday,
            weekendHolidayAfternoon: targetTWeekendHoliday,
            weekendHolidayNight: isNightShiftEnabled ? targetNWeekendHoliday : 0,
        };
         const currentOperationalRules: OperationalRules = {
            requiredDdWeekends: requiredDdWeekends,
            minCoverageTPT: minCoverageTPT,
            minCoverageM: minCoverageM,
            minCoverageT: minCoverageT,
            minCoverageN: isNightShiftEnabled ? minCoverageN : 0,
        };

         setTimeout(() => {
             try {
                calculateFinalTotals(scheduleToRecalculate, employees, absences, isNightShiftEnabled);
                const newReport = validateSchedule(
                    scheduleToRecalculate,
                    employees,
                    absences,
                    holidays,
                    currentTargetStaffing,
                    maxConsecutiveWork,
                    maxConsecutiveRest,
                    currentOperationalRules,
                    isNightShiftEnabled,
                    preferredConsecutiveWorkDays,
                    preferredConsecutiveRestDays
                );
                setSchedule(scheduleToRecalculate);
                setReport(newReport);
                setScheduleScore(calculateScheduleScore(newReport));
            } catch (error) {
                console.error("Error during recalculation:", error);
                setReport([{rule: "Error de Recálculo", passed: false, details: `Error inesperado: ${error instanceof Error ? error.message : 'Error desconocido'}`}]);
                setScheduleScore(0);
            } finally {
                 setIsLoading(false);
            }
         }, 50)
    }

  const handleRefineSchedule = () => {
        if (!schedule || !employees || !selectedMonth || !selectedYear) {
            toast({ title: "Error", description: "No hay horario cargado o datos incompletos para refinar.", variant: "destructive" });
            return;
        }
        setIsLoading(true);
        setReport([]);
        setScheduleScore(null);

        const currentTargetStaffing: TargetStaffing = {
            workdayMorning: targetMWorkday,
            workdayAfternoon: targetTWorkday,
            workdayNight: isNightShiftEnabled ? targetNWorkday : 0,
            weekendHolidayMorning: targetMWeekendHoliday,
            weekendHolidayAfternoon: targetTWeekendHoliday,
            weekendHolidayNight: isNightShiftEnabled ? targetNWeekendHoliday : 0,
        };
        const currentOperationalRules: OperationalRules = {
            requiredDdWeekends: requiredDdWeekends,
            minCoverageTPT: minCoverageTPT,
            minCoverageM: minCoverageM,
            minCoverageT: minCoverageT,
            minCoverageN: isNightShiftEnabled ? minCoverageN : 0,
        };

        setTimeout(() => {
            try {
                const result = refineSchedule(
                    JSON.parse(JSON.stringify(schedule)),
                    JSON.parse(JSON.stringify(employees)),
                    JSON.parse(JSON.stringify(absences)),
                    JSON.parse(JSON.stringify(holidays)),
                    currentTargetStaffing,
                    maxConsecutiveWork,
                    maxConsecutiveRest,
                    currentOperationalRules,
                    isNightShiftEnabled,
                    preferredConsecutiveWorkDays,
                    preferredConsecutiveRestDays
                );
                setSchedule(result.schedule);
                setReport(result.report);
                setScheduleScore(calculateScheduleScore(result.report));
                toast({ title: "Horario Refinado", description: "Se ha intentado mejorar la distribución de descansos. Revisa el resultado." });
            } catch (error) {
                console.error("Error refining schedule:", error);
                setReport([{ rule: "Error de Refinamiento", passed: false, details: `Error inesperado: ${error instanceof Error ? error.message : 'Error desconocido'}` }]);
                setScheduleScore(0);
            } finally {
                setIsLoading(false);
            }
        }, 50);
    };


  const exportScheduleToCSV = () => {
    if (!schedule || !employees || selectedMonth === null || selectedYear === null) return;

    const monthName = MONTHS.find(m => m.value === selectedMonth)?.label.toUpperCase() || 'MesDesconocido';
    const defaultFileName = `horario_${monthName}_${selectedYear}.csv`;

    let userFileName = window.prompt("Ingrese el nombre para el archivo CSV:", defaultFileName);

    if (userFileName === null) {
        return;
    }
    if (userFileName.trim() === "") {
        userFileName = defaultFileName;
    }
    if (!userFileName.toLowerCase().endsWith(".csv")) {
        userFileName += ".csv";
    }

    let csvContent = "data:text/csv;charset=utf-8,";


    const dayNumbers = schedule.days.map(day => format(parseISO(day.date), 'd'));
    const headerBase = ["Empleado", "Total D", "Total M", "Total T"];
    if (isNightShiftEnabled) headerBase.push("Total N");
    const headerRow = [...headerBase, ...dayNumbers].join(",");
    csvContent += headerRow + "\r\n";

    employees.forEach(emp => {
        const totals = schedule.employeeTotals[emp.id] || { D: 0, M: 0, T: 0, N: 0, F: 0, C: 0, LAO: 0, LM: 0, workedDays: 0, freeSaturdays: 0, freeSundays: 0 };
        const dailyShiftsArray = schedule.days.map(day => day.shifts[emp.id] || "");
        const employeeRowBase = [emp.name, totals.D, totals.M, totals.T];
        if(isNightShiftEnabled) employeeRowBase.push(totals.N);
        const employeeRow = [...employeeRowBase, ...dailyShiftsArray].join(",");
        csvContent += employeeRow + "\r\n";
    });
    csvContent += "\r\n";
    const totalPlaceholders = Array(headerBase.length - 1).fill("");
    csvContent += ["Total Mañana (TM)", ...totalPlaceholders, ...schedule.days.map(day => day.totals.M)].join(",") + "\r\n";
    csvContent += ["Total Tarde (TT)", ...totalPlaceholders, ...schedule.days.map(day => day.totals.T)].join(",") + "\r\n";
    if (isNightShiftEnabled) {
        csvContent += ["Total Noche (TN)", ...totalPlaceholders, ...schedule.days.map(day => day.totals.N)].join(",") + "\r\n";
    }
    csvContent += ["TOTAL PERSONAL (TPT)", ...totalPlaceholders, ...schedule.days.map(day => day.totals.TPT)].join(",") + "\r\n";


    csvContent += "\r\n\r\n";
    csvContent += `${EMPLOYEE_CONFIG_HEADER_TOKEN};Nombre;ElegibleFindeDD;PrefiereTrabajarFinde;TurnoFijoSemanal_JSON;AsignacionesFijas_JSON\r\n`;
    employees.forEach(emp => {
        const fixedWorkShiftJson = emp.preferences.fixedWorkShift ? JSON.stringify(emp.preferences.fixedWorkShift) : "null";
        const fixedAssignmentsJson = emp.preferences.fixedAssignments && emp.preferences.fixedAssignments.length > 0 ? JSON.stringify(emp.preferences.fixedAssignments) : "[]";
        csvContent += `${emp.name};${emp.eligibleWeekend};${emp.preferences.preferWeekendWork || false};${fixedWorkShiftJson};${fixedAssignmentsJson}\r\n`;
    });


    const previousDatesForHistory = getPreviousMonthDates();
    if (previousDatesForHistory.length > 0 && Object.keys(historyInputs).length > 0) {
        csvContent += "\r\n\r\n";
        const historyHeaderCells = [HISTORY_CSV_HEADER_TOKEN, ...previousDatesForHistory.map(d => format(parseISO(d), 'yyyy-MM-dd'))];
        csvContent += historyHeaderCells.join(";") + "\r\n";
        employees.forEach(emp => {
            const empHistory = historyInputs[emp.id] || {};
            const historyRowValues = previousDatesForHistory.map(dateStr => empHistory[dateStr] || "");
            csvContent += [emp.name, ...historyRowValues].join(",") + "\r\n";
        });
    }


    if (holidays.length > 0) {
        csvContent += "\r\n\r\n";
        csvContent += `${HOLIDAYS_HEADER_TOKEN};Fecha;Descripcion\r\n`;
        holidays.forEach(hol => {
            csvContent += `${hol.date};${hol.description}\r\n`;
        });
    }


    if (absences.length > 0) {
        csvContent += "\r\n\r\n";
        csvContent += `${ABSENCES_HEADER_TOKEN};NombreEmpleado;Tipo;FechaInicio;FechaFin\r\n`;
        absences.forEach(abs => {
            const empName = employees.find(e => e.id === abs.employeeId)?.name || `ID_EMPLEADO_DESCONOCIDO_${abs.employeeId}`;
            csvContent += `${empName};${abs.type};${abs.startDate};${abs.endDate}\r\n`;
        });
    }

    csvContent += "\r\n\r\n";
    csvContent += `${CONFIG_TARGET_STAFFING_TOKEN};targetMWorkday;targetTWorkday;targetNWorkday;targetMWeekendHoliday;targetTWeekendHoliday;targetNWeekendHoliday\r\n`;
    csvContent += `${targetMWorkday};${targetTWorkday};${targetNWorkday};${targetMWeekendHoliday};${targetTWeekendHoliday};${targetNWeekendHoliday}\r\n`;

    csvContent += "\r\n\r\n";
    csvContent += `${CONFIG_CONSECUTIVITY_RULES_TOKEN};maxConsecutiveWork;maxConsecutiveRest;preferredConsecutiveWork;preferredConsecutiveRest\r\n`;
    csvContent += `${maxConsecutiveWork};${maxConsecutiveRest};${preferredConsecutiveWorkDays};${preferredConsecutiveRestDays}\r\n`;


    csvContent += "\r\n\r\n";
    csvContent += `${CONFIG_OPERATIONAL_RULES_TOKEN};requiredDdWeekends;minCoverageTPT;minCoverageM;minCoverageT;minCoverageN\r\n`;
    csvContent += `${requiredDdWeekends};${minCoverageTPT};${minCoverageM};${minCoverageT};${minCoverageN}\r\n`;

    csvContent += "\r\n\r\n";
    csvContent += `${CONFIG_NIGHT_SHIFT_TOKEN};isNightShiftEnabled\r\n`;
    csvContent += `${isNightShiftEnabled}\r\n`;


    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", userFileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};


  const getDayHeaders = useMemo(() => {
    if (!schedule) return [];
    return schedule.days.map(day => {
      try {
        const date = parseISO(day.date);
        if (!isValid(date)) throw new Error('Invalid date');
        const dayOfMonth = format(date, 'd');
        const dayOfWeek = format(date, 'eee', { locale: es });
        return { dayOfMonth, dayOfWeek, isWeekend: day.isWeekend, isHoliday: day.isHoliday };
      } catch (e) {
        console.error(`Error parsing date: ${day.date}`, e);
        return { dayOfMonth: 'Err', dayOfWeek: 'Err', isWeekend: false, isHoliday: false };
      }
    });
  }, [schedule]);

  const getShiftCellClass = (shift: ShiftType | null): string => {
    if (shift === null) return "bg-destructive text-destructive-foreground";
    return SHIFT_COLORS[shift] || "bg-background";
  };

   const getTotalsCellClass = (): string => {
       return TOTALS_COLOR;
   }

   const getValidationIcon = (passed: boolean, rule: string) => {
    if (!passed && (rule.startsWith("Prioridad 1") || rule.includes("Cobertura Mínima") || rule.includes("Cobertura TPT") || rule.includes("Ratio M-T") || rule.includes("Máx Días Consecutivos") || rule.includes("Descanso Post-Noche") || rule.includes("Completitud"))) {
        return <XCircle className="text-red-600 h-5 w-5" />;
    }
    if (!passed && (rule.startsWith("Prioridad 3") || rule.startsWith("Prioridad 4") || rule.includes("Ranura Vacía Persistente") || rule.includes("Descanso T->M") || rule.includes("Descanso Compensatorio"))) {
        return <AlertTriangle className="text-yellow-500 h-5 w-5" />;
    }
    if (!passed && (rule.startsWith("Flexible") || rule.startsWith("Preferencia Flexible") || rule.startsWith("Info Generador") || rule.startsWith("Potencial"))) {
        return <Info className="text-blue-500 h-5 w-5" />;
    }
    if (passed) {
        return <CheckCircle className="text-green-600 h-5 w-5" />;
    }
    return <Info className="text-gray-500 h-5 w-5" />;
};

const getAlertVariant = (passed: boolean, rule: string): "default" | "destructive" => {
    if (!passed && (rule.startsWith("Prioridad 1") || rule.includes("Cobertura Mínima")|| rule.includes("Cobertura TPT") || rule.includes("Ratio M-T") || rule.includes("Máx Días Consecutivos") || rule.includes("Descanso Post-Noche") || rule.includes("Completitud"))) {
        return "destructive";
    }
    return "default";
};

const getAlertCustomClasses = (passed: boolean, rule: string): string => {
    if (passed) return "bg-green-50 border-green-300";
    if (!passed) {
        if (rule.startsWith("Prioridad 1") || rule.includes("Cobertura Mínima") || rule.includes("Cobertura TPT") || rule.includes("Ratio M-T") || rule.includes("Máx Días Consecutivos") || rule.includes("Descanso Post-Noche") || rule.includes("Completitud")) {
             return "bg-red-50 border-red-300";
        }
        if (rule.startsWith("Prioridad 3") || rule.startsWith("Prioridad 4") || rule.includes("Ranura Vacía Persistente") || rule.includes("Descanso T->M") || rule.includes("Descanso Compensatorio")) {
            return "bg-yellow-50 border-yellow-300";
        }
        if (rule.startsWith("Flexible") || rule.startsWith("Preferencia Flexible") || rule.startsWith("Info Generador") || rule.startsWith("Potencial")) {
            return "bg-blue-50 border-blue-300";
        }
    }
    return "bg-gray-50 border-gray-300";
};

    const daysOfWeekOptions = [
        { value: 1, label: 'Lunes' }, { value: 2, label: 'Martes' }, { value: 3, label: 'Miércoles' },
        { value: 4, label: 'Jueves' }, { value: 5, label: 'Viernes' }, { value: 6, label: 'Sábado' },
        { value: 0, label: 'Domingo' }
    ];

    const currentAllowedFixedShifts = useMemo(() => {
        return isNightShiftEnabled ? ALLOWED_FIXED_ASSIGNMENT_SHIFTS : ALLOWED_FIXED_ASSIGNMENT_SHIFTS.filter(s => s !== 'N');
    }, [isNightShiftEnabled]);

    const currentWeeklyFixedShiftOptions = useMemo(() => {
        const baseOptions = Array.from(new Set<ShiftType>([...ALLOWED_FIXED_ASSIGNMENT_SHIFTS, 'D', 'C', 'N']));
        return isNightShiftEnabled ? baseOptions : baseOptions.filter(s => s !== 'N');
    }, [isNightShiftEnabled]);

     const manualShiftOptions = useMemo(() => {
        const baseOptions = ['NULL', ...SHIFT_TYPES].map(opt => ({value: opt, label: opt === 'NULL' ? '-' : opt }));
        return isNightShiftEnabled ? baseOptions : baseOptions.filter(opt => opt.value !== 'N');
    }, [isNightShiftEnabled]);

    const getStepTitle = () => {
        switch (currentStep) {
            case 1: return "Paso 1 de 3: Período y Personal";
            case 2: return "Paso 2 de 3: Dotación Objetivo";
            case 3: return "Paso 3 de 3: Reglas y Generación";
            default: return "Ayuda horarios - Configuración";
        }
    };

  return (
    <div className="container mx-auto p-4 md:p-8">
       {displayMode === 'config' && (
            <Card className="mb-8 shadow-md">
                <CardHeader>
                <CardTitle className="text-2xl font-bold text-primary">{getStepTitle()}</CardTitle>
                <CardDescription>Configure los parámetros para la generación del horario o cargue uno existente.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    {currentStep === 1 && (
                        <>
                            <div className="flex flex-col md:flex-row gap-4 items-end justify-between">
                                <div className="flex gap-4 w-full md:w-auto">
                                    <div className="flex-1">
                                        <Label htmlFor="month-select">Mes</Label>
                                        <Select
                                            value={selectedMonth?.toString() || ""}
                                            onValueChange={(value) => setSelectedMonth(parseInt(value))}
                                            disabled={!isDateInitialized}
                                        >
                                            <SelectTrigger id="month-select">
                                                <SelectValue placeholder={isDateInitialized ? "Seleccionar mes" : "Cargando..."} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {MONTHS.map(m => (
                                                    <SelectItem key={m.value} value={m.value.toString()}>{m.label}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="flex-1">
                                        <Label htmlFor="year-select">Año</Label>
                                        <Select
                                            value={selectedYear?.toString() || ""}
                                            onValueChange={(value) => setSelectedYear(parseInt(value))}
                                            disabled={!isDateInitialized}
                                        >
                                            <SelectTrigger id="year-select">
                                            <SelectValue placeholder={isDateInitialized ? "Seleccionar año" : "Cargando..."} />
                                            </SelectTrigger>
                                            <SelectContent>
                                            {[CURRENT_YEAR - 2, CURRENT_YEAR -1 , CURRENT_YEAR, CURRENT_YEAR + 1, CURRENT_YEAR + 2].map(y => (
                                                <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                                            ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                                <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
                                     <Button
                                        variant="outline"
                                        onClick={() => document.getElementById('fullScheduleImportInput')?.click()}
                                        disabled={isLoading || !isDateInitialized || !selectedMonth || !selectedYear}
                                        className="flex-1"
                                    >
                                        <Upload className="mr-2 h-4 w-4" /> Cargar Horario CSV Completo
                                    </Button>
                                    <Input
                                        type="file"
                                        id="fullScheduleImportInput"
                                        className="hidden"
                                        accept=".csv"
                                        onChange={handleLoadFullScheduleFromCSV}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                <Card>
                                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                                        <CardTitle className="text-lg font-medium">Empleados</CardTitle>
                                        <Dialog open={isEmployeeDialogOpen} onOpenChange={(isOpen) => {
                                            setIsEmployeeDialogOpen(isOpen);
                                            if (!isOpen) {
                                                setEditingEmployee(null);
                                                employeeForm.reset({ name: '', eligibleWeekend: true, preferences: { fixedAssignments: [], preferWeekendWork: false, fixedWorkShift: undefined }});
                                            }
                                        }}>
                                            <DialogTrigger asChild>
                                                <Button size="sm" variant="outline" onClick={() => { setEditingEmployee(null); employeeForm.reset({ name: '', eligibleWeekend: true, preferences: { fixedAssignments: [], preferWeekendWork: false, fixedWorkShift: undefined }}); setIsEmployeeDialogOpen(true);}}>
                                                    <PlusCircle className="mr-2 h-4 w-4" /> Añadir
                                                </Button>
                                            </DialogTrigger>
                                            <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
                                                <DialogHeader>
                                                    <DialogTitle>{editingEmployee ? 'Editar' : 'Añadir'} Empleado</DialogTitle>
                                                </DialogHeader>
                                                <form onSubmit={employeeForm.handleSubmit(editingEmployee ? handleUpdateEmployee : handleAddEmployee)} className="space-y-4 p-1">
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                        <div>
                                                            <Label htmlFor="name">Nombre</Label>
                                                            <Input id="name" {...employeeForm.register("name")} />
                                                            {employeeForm.formState.errors.name && <p className="text-red-500 text-xs mt-1">{employeeForm.formState.errors.name.message}</p>}
                                                        </div>
                                                        <div className="flex items-center pt-6 space-x-2">
                                                        <Controller
                                                                name="eligibleWeekend"
                                                                control={employeeForm.control}
                                                                render={({ field }) => (
                                                                    <Checkbox
                                                                        id="eligibleWeekend"
                                                                        checked={field.value}
                                                                        onCheckedChange={field.onChange}
                                                                    />
                                                                )}
                                                            />
                                                            <Label htmlFor="eligibleWeekend">¿Elegible Franco D/D?</Label>
                                                        </div>
                                                    </div>

                                                    <h3 className="text-md font-semibold border-t pt-4">Preferencias (Opcional)</h3>
                                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                                        <div className="flex items-center space-x-2">
                                                            <Controller name="preferences.preferWeekendWork" control={employeeForm.control} render={({ field }) => (<Checkbox id="prefWeekendWork" checked={!!field.value} onCheckedChange={field.onChange} /> )}/>
                                                            <Label htmlFor="prefWeekendWork">Prefiere Trabajar Finde</Label>
                                                        </div>

                                                    </div>

                                                    <div className="space-y-2">
                                                        <Label>Asignaciones Fijas</Label>
                                                        {fixedAssignmentsFields.map((field, index) => (
                                                            <div key={field.id} className="flex gap-2 items-center">
                                                                <Input type="date" {...employeeForm.register(`preferences.fixedAssignments.${index}.date`)} placeholder="YYYY-MM-DD" className="flex-1"/>
                                                                <Controller
                                                                    name={`preferences.fixedAssignments.${index}.shift`}
                                                                    control={employeeForm.control}
                                                                    render={({ field }) => (
                                                                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                                                                            <SelectTrigger className="w-[100px]"> <SelectValue placeholder="Turno" /> </SelectTrigger>
                                                                            <SelectContent>
                                                                                {currentAllowedFixedShifts.map(st => <SelectItem key={st} value={st}>{st}</SelectItem>)}
                                                                            </SelectContent>
                                                                        </Select>
                                                                    )}
                                                                />
                                                                <Button type="button" variant="ghost" size="icon" onClick={() => removeFixedAssignment(index)}><Trash2 className="h-4 w-4"/></Button>
                                                            </div>
                                                        ))}
                                                        {employeeForm.formState.errors.preferences?.fixedAssignments?.root && <p className="text-red-500 text-xs mt-1">{employeeForm.formState.errors.preferences.fixedAssignments.root.message}</p>}
                                                        {employeeForm.formState.errors.preferences?.fixedAssignments?.map((err, idx)=> err && Object.values(err).map((fieldErr: any) => <p key={`${idx}-${fieldErr?.message}`} className="text-red-500 text-xs mt-1">{fieldErr?.message}</p> ) )}

                                                        <Button type="button" variant="outline" size="sm" onClick={() => appendFixedAssignment({ date: '', shift: 'M' })}>+ Asignación</Button>
                                                    </div>


                                                    <div className="space-y-2 border-t pt-4">
                                                        <Label>Turno Fijo Semanal (Ej: Alamo)</Label>
                                                        <Controller
                                                            name="preferences.fixedWorkShift"
                                                            control={employeeForm.control}
                                                            render={({ field }) => (
                                                            <div className="space-y-2">
                                                                <Label className="text-xs">Días de la Semana</Label>
                                                                <div className="grid grid-cols-3 gap-2">
                                                                    {daysOfWeekOptions.map(day => (
                                                                        <div key={day.value} className="flex items-center space-x-2">
                                                                            <Checkbox
                                                                                id={`fixedDay-${day.value}`}
                                                                                checked={field.value?.dayOfWeek?.includes(day.value) ?? false}
                                                                                onCheckedChange={(checked) => {
                                                                                    const currentDays = field.value?.dayOfWeek ?? [];
                                                                                    const newDays = checked
                                                                                        ? [...currentDays, day.value]
                                                                                        : currentDays.filter(d => d !== day.value);
                                                                                    const currentShift = field.value?.shift ?? (isNightShiftEnabled ? 'M' : 'M');
                                                                                    field.onChange({ dayOfWeek: newDays, shift: currentShift as ShiftType });
                                                                                }}
                                                                            />
                                                                            <Label htmlFor={`fixedDay-${day.value}`} className="text-sm">{day.label}</Label>
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                                <Label className="text-xs">Turno Fijo</Label>
                                                                <Select
                                                                    value={field.value?.shift}
                                                                    onValueChange={(shift) => field.onChange({ ...field.value, dayOfWeek: field.value?.dayOfWeek ?? [], shift: shift as ShiftType })}
                                                                    disabled={!field.value?.dayOfWeek || field.value.dayOfWeek.length === 0}
                                                                >
                                                                    <SelectTrigger><SelectValue placeholder="Seleccionar Turno" /></SelectTrigger>
                                                                    <SelectContent>
                                                                        {currentWeeklyFixedShiftOptions.map(st => <SelectItem key={st} value={st}>{st}</SelectItem>)}
                                                                    </SelectContent>
                                                                </Select>
                                                                <Button type="button" variant="link" size="sm" onClick={() => field.onChange(undefined)}>Limpiar Turno Fijo</Button>
                                                            </div>
                                                            )}
                                                        />
                                                    </div>


                                                    <DialogFooter>
                                                        <DialogClose asChild>
                                                            <Button type="button" variant="outline">Cancelar</Button>
                                                        </DialogClose>
                                                        <Button type="submit"><Save className="mr-2 h-4 w-4" />{editingEmployee ? 'Guardar Cambios' : 'Añadir Empleado'}</Button>
                                                    </DialogFooter>
                                                </form>
                                            </DialogContent>
                                        </Dialog>
                                    </CardHeader>
                                    <CardContent>
                                        <ul className="space-y-2">
                                            {employees.map(emp => (
                                                <li key={emp.id} className="flex justify-between items-center text-sm p-2 border rounded">
                                                    {emp.name} ({emp.eligibleWeekend ? 'Elegible Finde D/D' : 'No Elegible'})
                                                    <div className="flex gap-1">
                                                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditEmployeeDialog(emp)}>
                                                            <Edit className="h-4 w-4" />
                                                        </Button>
                                                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteEmployee(emp.id)}>
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                </li>
                                            ))}
                                            {employees.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No hay empleados definidos. Importe desde CSV o añada manualmente.</p>}
                                        </ul>
                                        <div className="mt-4 space-y-4 border-t pt-4">
                                            <h4 className="text-md font-semibold">Importar Empleados, Historial, Config. y Reglas</h4>
                                            <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById('csvImportInput')?.click()} className="mb-2 w-full">
                                                <Upload className="mr-2 h-4 w-4" /> Importar Empleados, Historial, Config. y Reglas CSV
                                            </Button>
                                            <Input
                                            type="file"
                                            id="csvImportInput"
                                            className="hidden"
                                            accept=".csv"
                                            onChange={handleImportHistoryFromCSV}
                                            />
                                            {employees.length > 0 && getPreviousMonthDates().length > 0 && (
                                            <>
                                            <p className="text-xs text-muted-foreground">Edite el historial importado si es necesario:</p>
                                            {employees.map(emp => (
                                                <div key={`hist-${emp.id}`} className="space-y-1">
                                                    <p className="text-sm font-medium">{emp.name}</p>
                                                    <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                                                        {getPreviousMonthDates().map(dateStr => (
                                                            <div key={`${emp.id}-${dateStr}`} className="flex flex-col">
                                                                <Label htmlFor={`hist-${emp.id}-${dateStr}`} className="text-xs mb-1">{format(parseISO(dateStr), 'dd/MM')}</Label>
                                                                <Select
                                                                    value={historyInputs[emp.id]?.[dateStr] || '-'}
                                                                    onValueChange={(value) => handleHistoryChange(emp.id, dateStr, value)}
                                                                >
                                                                    <SelectTrigger id={`hist-${emp.id}-${dateStr}`} className="h-8 text-xs">
                                                                        <SelectValue placeholder="-" />
                                                                    </SelectTrigger>
                                                                    <SelectContent>
                                                                        <SelectItem value="-">- (Vacío)</SelectItem>
                                                                        {SHIFT_TYPES.filter(st => isNightShiftEnabled || st !== 'N').map(st => (
                                                                            <SelectItem key={st} value={st}>{st}</SelectItem>
                                                                        ))}
                                                                    </SelectContent>
                                                                </Select>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                            </>
                                            )}
                                            {employees.length > 0 && getPreviousMonthDates().length === 0 && (
                                            <p className="text-xs text-muted-foreground">Seleccione mes/año principal para ver/editar historial del mes anterior.</p>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                                        <CardTitle className="text-lg font-medium">Ausencias (LAO/LM)</CardTitle>
                                        <Dialog open={isAbsenceDialogOpen} onOpenChange={(isOpen) => {
                                            setIsAbsenceDialogOpen(isOpen);
                                            if (!isOpen) {
                                                setEditingAbsence(null);
                                                absenceForm.reset();
                                            }
                                        }}>
                                            <DialogTrigger asChild>
                                                <Button size="sm" variant="outline" onClick={() => { setEditingAbsence(null); absenceForm.reset(); setIsAbsenceDialogOpen(true); }} disabled={employees.length === 0}>
                                                    <PlusCircle className="mr-2 h-4 w-4" /> Añadir
                                                </Button>
                                            </DialogTrigger>
                                        <DialogContent className="sm:max-w-[425px]">
                                                <DialogHeader>
                                                    <DialogTitle>{editingAbsence ? 'Editar' : 'Añadir'} Ausencia</DialogTitle>
                                                </DialogHeader>
                                                <form onSubmit={absenceForm.handleSubmit(editingAbsence ? handleUpdateAbsence : handleAddAbsence)} className="space-y-4">
                                                    <div>
                                                        <Label htmlFor="employeeId">Empleado</Label>
                                                        <Controller
                                                            name="employeeId"
                                                            control={absenceForm.control}
                                                            render={({ field }) => (
                                                                <Select onValueChange={(value) => field.onChange(parseInt(value))} value={field.value?.toString()}>
                                                                    <SelectTrigger><SelectValue placeholder="Seleccionar Empleado" /></SelectTrigger>
                                                                    <SelectContent>
                                                                        {employees.map(emp => <SelectItem key={emp.id} value={emp.id.toString()}>{emp.name}</SelectItem>)}
                                                                    </SelectContent>
                                                                </Select>
                                                            )}
                                                        />
                                                        {absenceForm.formState.errors.employeeId && <p className="text-red-500 text-xs mt-1">{absenceForm.formState.errors.employeeId.message}</p>}
                                                    </div>
                                                    <div>
                                                        <Label htmlFor="type">Tipo</Label>
                                                        <Controller
                                                            name="type"
                                                            control={absenceForm.control}
                                                            render={({ field }) => (
                                                                <Select onValueChange={field.onChange} defaultValue={field.value}>
                                                                    <SelectTrigger><SelectValue placeholder="Seleccionar Tipo" /></SelectTrigger>
                                                                    <SelectContent>
                                                                        <SelectItem value="LAO">LAO</SelectItem>
                                                                        <SelectItem value="LM">LM</SelectItem>
                                                                    </SelectContent>
                                                                </Select>
                                                            )} />
                                                        {absenceForm.formState.errors.type && <p className="text-red-500 text-xs mt-1">{absenceForm.formState.errors.type.message}</p>}
                                                    </div>
                                                    <div>
                                                        <Label htmlFor="startDate">Fecha Inicio</Label>
                                                        <Input id="startDate" type="date" {...absenceForm.register("startDate")} />
                                                        {absenceForm.formState.errors.startDate && <p className="text-red-500 text-xs mt-1">{absenceForm.formState.errors.startDate.message}</p>}
                                                    </div>
                                                    <div>
                                                        <Label htmlFor="endDate">Fecha Fin</Label>
                                                        <Input id="endDate" type="date" {...absenceForm.register("endDate")} />
                                                        {absenceForm.formState.errors.endDate && <p className="text-red-500 text-xs mt-1">{absenceForm.formState.errors.endDate.message}</p>}
                                                    </div>
                                                    <DialogFooter>
                                                        <DialogClose asChild><Button type="button" variant="outline">Cancelar</Button></DialogClose>
                                                        <Button type="submit"><Save className="mr-2 h-4 w-4" />{editingAbsence ? 'Guardar Cambios' : 'Añadir Ausencia'}</Button>
                                                    </DialogFooter>
                                                </form>
                                            </DialogContent>
                                        </Dialog>
                                    </CardHeader>
                                    <CardContent>
                                        <ul className="space-y-2">
                                        {absences.map(abs => {
                                                const empName = employees.find(e => e.id === abs.employeeId)?.name || 'Desconocido';
                                                let formattedStart = 'Invalid Date';
                                                let formattedEnd = 'Invalid Date';
                                                try {
                                                    formattedStart = format(parseISO(abs.startDate), 'dd/MM');
                                                    formattedEnd = format(parseISO(abs.endDate), 'dd/MM');
                                                } catch (e) {
                                                    console.error("Invalid date format in absence:", abs);
                                                }
                                                return (
                                                    <li key={abs.id} className="flex justify-between items-center text-sm p-2 border rounded">
                                                        <span>{empName}: {abs.type} ({formattedStart} - {formattedEnd})</span>
                                                        <div className="flex gap-1">
                                                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditAbsenceDialog(abs)}>
                                                                <Edit className="h-4 w-4" />
                                                            </Button>
                                                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteAbsence(abs.id!)}>
                                                                <Trash2 className="h-4 w-4" />
                                                            </Button>
                                                        </div>
                                                    </li>
                                                );
                                        })}
                                            {absences.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No hay ausencias definidas.</p>}
                                        </ul>
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                                        <CardTitle className="text-lg font-medium">Feriados</CardTitle>
                                        <Dialog open={isHolidayDialogOpen} onOpenChange={(isOpen) => {
                                                setIsHolidayDialogOpen(isOpen);
                                                if (!isOpen) {
                                                    setEditingHoliday(null);
                                                    holidayForm.reset();
                                                }
                                            }}>
                                            <DialogTrigger asChild>
                                                <Button size="sm" variant="outline" onClick={() => { setEditingHoliday(null); holidayForm.reset(); setIsHolidayDialogOpen(true); }}>
                                                    <PlusCircle className="mr-2 h-4 w-4" /> Añadir
                                                </Button>
                                            </DialogTrigger>
                                            <DialogContent className="sm:max-w-[425px]">
                                                <DialogHeader>
                                                    <DialogTitle>{editingHoliday ? 'Editar' : 'Añadir'} Feriado</DialogTitle>
                                                </DialogHeader>
                                                <form onSubmit={holidayForm.handleSubmit(editingHoliday ? handleUpdateHoliday : handleAddHoliday)} className="space-y-4">
                                                    <div>
                                                        <Label htmlFor="holidayDate">Fecha</Label>
                                                        <Input id="holidayDate" type="date" {...holidayForm.register("date")} />
                                                        {holidayForm.formState.errors.date && <p className="text-red-500 text-xs mt-1">{holidayForm.formState.errors.date.message}</p>}
                                                    </div>
                                                    <div>
                                                        <Label htmlFor="holidayDescription">Descripción</Label>
                                                        <Input id="holidayDescription" {...holidayForm.register("description")} />
                                                        {holidayForm.formState.errors.description && <p className="text-red-500 text-xs mt-1">{holidayForm.formState.errors.description.message}</p>}
                                                    </div>
                                                    <DialogFooter>
                                                        <DialogClose asChild><Button type="button" variant="outline">Cancelar</Button></DialogClose>
                                                        <Button type="submit"><Save className="mr-2 h-4 w-4" />{editingHoliday ? 'Guardar Cambios' : 'Añadir Feriado'}</Button>
                                                    </DialogFooter>
                                                </form>
                                            </DialogContent>
                                        </Dialog>
                                    </CardHeader>
                                    <CardContent>
                                        <ul className="space-y-2">
                                            {holidays.map(hol => {
                                                let formattedDate = 'Invalid Date';
                                                try {
                                                    formattedDate = format(parseISO(hol.date), 'dd/MM/yyyy');
                                                } catch (e) {
                                                    console.error("Invalid date format in holiday:", hol);
                                                }
                                                return (
                                                <li key={hol.id} className="flex justify-between items-center text-sm p-2 border rounded">
                                                    <span>{formattedDate}: {hol.description}</span>
                                                    <div className="flex gap-1">
                                                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditHolidayDialog(hol)}>
                                                            <Edit className="h-4 w-4" />
                                                        </Button>
                                                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDeleteHoliday(hol.id!)}>
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                </li>
                                            )})}
                                            {holidays.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No hay feriados definidos.</p>}
                                        </ul>
                                    </CardContent>
                                </Card>
                            </div>
                             <div className="flex justify-end mt-6">
                                <Button onClick={() => setCurrentStep(2)} disabled={isLoading}>Siguiente</Button>
                            </div>
                        </>
                    )}

                    {currentStep === 2 && (
                        <>
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-lg font-medium">Dotación Objetivo</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="mb-4 flex items-center space-x-2">
                                        <Checkbox
                                            id="enableNightShift"
                                            checked={isNightShiftEnabled}
                                            onCheckedChange={(checked) => setIsNightShiftEnabled(Boolean(checked))}
                                        />
                                        <Label htmlFor="enableNightShift" className="text-sm font-medium">
                                            Habilitar Turno Noche (N)
                                        </Label>
                                    </div>
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                        <div>
                                            <Label htmlFor="targetMWorkday">Mañanas (L-V)</Label>
                                            <Input id="targetMWorkday" type="number" value={targetMWorkday} onChange={(e) => setTargetMWorkday(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                        <div>
                                            <Label htmlFor="targetTWorkday">Tardes (L-V)</Label>
                                            <Input id="targetTWorkday" type="number" value={targetTWorkday} onChange={(e) => setTargetTWorkday(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                        {isNightShiftEnabled && (
                                            <div>
                                                <Label htmlFor="targetNWorkday">Noches (L-V)</Label>
                                                <Input id="targetNWorkday" type="number" value={targetNWorkday} onChange={(e) => setTargetNWorkday(parseInt(e.target.value) || 0)} min="0" />
                                            </div>
                                        )}
                                        <div>
                                            <Label htmlFor="targetMWeekendHoliday">Mañanas (S,D,Feriado)</Label>
                                            <Input id="targetMWeekendHoliday" type="number" value={targetMWeekendHoliday} onChange={(e) => setTargetMWeekendHoliday(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                        <div>
                                            <Label htmlFor="targetTWeekendHoliday">Tardes (S,D,Feriado)</Label>
                                            <Input id="targetTWeekendHoliday" type="number" value={targetTWeekendHoliday} onChange={(e) => setTargetTWeekendHoliday(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                        {isNightShiftEnabled && (
                                            <div>
                                                <Label htmlFor="targetNWeekendHoliday">Noches (S,D,Feriado)</Label>
                                                <Input id="targetNWeekendHoliday" type="number" value={targetNWeekendHoliday} onChange={(e) => setTargetNWeekendHoliday(parseInt(e.target.value) || 0)} min="0" />
                                            </div>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                             <div className="flex justify-between mt-6">
                                <Button variant="outline" onClick={() => setCurrentStep(1)} disabled={isLoading}>Anterior</Button>
                                <Button onClick={() => setCurrentStep(3)} disabled={isLoading}>Siguiente</Button>
                            </div>
                        </>
                    )}

                    {currentStep === 3 && (
                        <>
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-lg font-medium">Reglas de Consecutividad</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <Label htmlFor="maxConsecutiveWork">Máx. Días Trabajo Consecutivos</Label>
                                            <Input id="maxConsecutiveWork" type="number" value={maxConsecutiveWork} onChange={(e) => setMaxConsecutiveWork(parseInt(e.target.value) || 1)} min="1" />
                                        </div>
                                        <div>
                                            <Label htmlFor="maxConsecutiveRest">Máx. Descansos (D/F/C) Consecutivos</Label>
                                            <Input id="maxConsecutiveRest" type="number" value={maxConsecutiveRest} onChange={(e) => setMaxConsecutiveRest(parseInt(e.target.value) || 1)} min="1" />
                                        </div>
                                        <div>
                                            <Label htmlFor="preferredConsecutiveWorkDays">Días Trabajo Consecutivos Preferidos</Label>
                                            <Input id="preferredConsecutiveWorkDays" type="number" value={preferredConsecutiveWorkDays} onChange={(e) => setPreferredConsecutiveWorkDays(parseInt(e.target.value) || 1)} min="1" />
                                        </div>
                                        <div>
                                            <Label htmlFor="preferredConsecutiveRestDays">Días Descanso Consecutivos Preferidos</Label>
                                            <Input id="preferredConsecutiveRestDays" type="number" value={preferredConsecutiveRestDays} onChange={(e) => setPreferredConsecutiveRestDays(parseInt(e.target.value) || 1)} min="1" />
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-lg font-medium">Reglas Operativas Adicionales</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                        <div>
                                            <Label htmlFor="requiredDdWeekends">Fines de Semana D/D (o C/C,F/F)</Label>
                                            <Input id="requiredDdWeekends" type="number" value={requiredDdWeekends} onChange={(e) => setRequiredDdWeekends(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                        <div>
                                            <Label htmlFor="minCoverageM">Mín. Personal Mañana (M)</Label>
                                            <Input id="minCoverageM" type="number" value={minCoverageM} onChange={(e) => setMinCoverageM(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                        <div>
                                            <Label htmlFor="minCoverageT">Mín. Personal Tarde (T)</Label>
                                            <Input id="minCoverageT" type="number" value={minCoverageT} onChange={(e) => setMinCoverageT(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                        {isNightShiftEnabled && (
                                            <div>
                                                <Label htmlFor="minCoverageN">Mín. Personal Noche (N)</Label>
                                                <Input id="minCoverageN" type="number" value={minCoverageN} onChange={(e) => setMinCoverageN(parseInt(e.target.value) || 0)} min="0" />
                                            </div>
                                        )}
                                        <div>
                                            <Label htmlFor="minCoverageTPT">Mín. Personal Total (TPT = M+T)</Label>
                                            <Input id="minCoverageTPT" type="number" value={minCoverageTPT} onChange={(e) => setMinCoverageTPT(parseInt(e.target.value) || 0)} min="0" />
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                            <div className="flex justify-between mt-6">
                                <Button variant="outline" onClick={() => setCurrentStep(2)} disabled={isLoading}>Anterior</Button>
                                <Button onClick={handleGenerateSchedule} disabled={isLoading || !isDateInitialized || !selectedMonth || !selectedYear}>
                                    {isLoading ? 'Generando...' : 'Generar Horario'}
                                </Button>
                            </div>
                        </>
                    )}
                </CardContent>
            </Card>
        )}

      {displayMode === 'viewing' && (
         <>
             {isLoading && (
                <div className="text-center p-8"><div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-primary mx-auto"></div><p className="mt-4">Generando o recalculando horario...</p></div>
             )}

            {!isLoading && schedule && selectedMonth !== null && selectedYear !== null && (
                <Card className="mb-8 overflow-x-auto shadow-md">
                <CardHeader>
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                        <div>
                             <CardTitle className="text-xl">Horario: {MONTHS.find(m=>m.value === selectedMonth)?.label} {selectedYear}</CardTitle>
                             <CardDescription>Puedes editar los turnos manualmente. Usa "Recalcular" para actualizar totales y validaciones.</CardDescription>
                        </div>
                         <div className="flex flex-wrap gap-2">
                            <Button variant="outline" onClick={() => {
                                setDisplayMode('config');
                                setCurrentStep(1);
                            }} disabled={isLoading}>
                                <ArrowLeft className="mr-2 h-4 w-4"/> Volver a Configuración
                            </Button>
                             <Button onClick={handleRecalculate} disabled={isLoading}>Recalcular Totales y Validar</Button>
                             <Button onClick={handleRefineSchedule} disabled={isLoading} variant="outline">
                                <Zap className="mr-2 h-4 w-4" /> Refinar Horario Actual
                             </Button>
                             <Button onClick={exportScheduleToCSV} disabled={isLoading} variant="outline">
                                <Download className="mr-2 h-4 w-4" /> Exportar a CSV
                             </Button>
                         </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <Table className="min-w-full border-collapse">
                    <TableHeader>
                        <TableRow className="bg-secondary">
                        <TableHead className="sticky left-0 bg-secondary z-30 border p-1 text-center font-semibold min-w-[170px] w-[170px]">Empleado</TableHead>
                        <TableHead className={cn("sticky left-[170px] bg-secondary z-20 border p-1 text-center font-semibold min-w-[60px] w-[60px]", getTotalsCellClass())}>D</TableHead>

                        {getDayHeaders.map(({ dayOfMonth, dayOfWeek, isWeekend, isHoliday }, index) => (
                            <TableHead
                            key={index}
                            className={cn(
                                "border p-1 text-center text-xs font-semibold min-w-[70px] w-[70px]",
                                isWeekend && "bg-muted text-muted-foreground",
                                isHoliday && "bg-accent text-accent-foreground font-bold"
                            )}
                            >
                            <div>{dayOfMonth}</div>
                            <div>{dayOfWeek}</div>
                            </TableHead>
                        ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {employees.map(emp => (
                        <TableRow key={emp.id}>
                            <TableCell className="sticky left-0 bg-background z-30 border p-1 font-medium text-sm whitespace-nowrap min-w-[170px] w-[170px]">{emp.name}</TableCell>
                            <TableCell className={cn("sticky left-[170px] bg-background z-20 border p-1 text-center text-xs font-medium min-w-[60px] w-[60px]", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.D ?? 0}</TableCell>

                            {schedule.days.map(day => {
                            const currentShift = day.shifts[emp.id];
                            const selectValue = currentShift === null ? 'NULL' : currentShift;
                            return (
                                <TableCell key={`${emp.id}-${day.date}`} className={cn("border p-0 text-center text-xs font-medium min-w-[70px] w-[70px]", getShiftCellClass(currentShift))}>
                                <Select
                                        value={selectValue || undefined}
                                        onValueChange={(newValue) => handleManualShiftChange(emp.id, day.date, newValue)}
                                        >
                                    <SelectTrigger className={cn("w-full h-full text-xs border-0 rounded-none focus:ring-0 focus:ring-offset-0 px-1 py-0", getShiftCellClass(currentShift))} aria-label={`Shift for ${emp.name} on ${day.date}`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                            {manualShiftOptions.map(opt => (
                                            <SelectItem key={opt.value} value={opt.value}>
                                                {opt.label}
                                                </SelectItem>
                                            ))}
                                    </SelectContent>
                                </Select>
                                </TableCell>
                            );
                            })}
                        </TableRow>
                        ))}
                        <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                        <TableCell className={cn("sticky left-0 bg-yellow-100 text-yellow-800 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>Total Mañana (TM)</TableCell>
                        <TableCell className={cn("sticky left-[170px] bg-yellow-100 text-yellow-800 z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                        {schedule.days.map(day => <TableCell key={`TM-${day.date}`} className="border p-1 text-center text-xs">{day.totals.M}</TableCell>)}
                        </TableRow>
                        <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                            <TableCell className={cn("sticky left-0 bg-yellow-100 text-yellow-800 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>Total Tarde (TT)</TableCell>
                            <TableCell className={cn("sticky left-[170px] bg-yellow-100 text-yellow-800 z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                            {schedule.days.map(day => <TableCell key={`TT-${day.date}`} className="border p-1 text-center text-xs">{day.totals.T}</TableCell>)}
                        </TableRow>
                         {isNightShiftEnabled && (
                            <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                                <TableCell className={cn("sticky left-0 bg-yellow-100 text-yellow-800 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>Total Noche (TN)</TableCell>
                                <TableCell className={cn("sticky left-[170px] bg-yellow-100 text-yellow-800 z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                                {schedule.days.map(day => <TableCell key={`TN-${day.date}`} className="border p-1 text-center text-xs">{day.totals.N}</TableCell>)}
                            </TableRow>
                         )}
                         <TableRow className={cn("font-bold", getTotalsCellClass())}>
                            <TableCell className={cn("sticky left-0 bg-yellow-100 text-yellow-800 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>TOTAL PERSONAL (TPT)</TableCell>
                             <TableCell className={cn("sticky left-[170px] bg-yellow-100 text-yellow-800 z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                            {schedule.days.map(day => <TableCell key={`TPT-${day.date}`} className={cn("border p-1 text-center text-xs", (day.totals.TPT < minCoverageTPT || (!day.isHoliday && !day.isWeekend && day.totals.TPT > minCoverageTPT && day.totals.M <= day.totals.T)) && "bg-destructive text-destructive-foreground font-bold")}>{day.totals.TPT}</TableCell>)}
                        </TableRow>
                    </TableBody>
                    </Table>
                </CardContent>
                </Card>
            )}

             {report.length > 0 && !isLoading && (
                <Card className="shadow-md">
                <CardHeader>
                    <CardTitle className="text-xl">Reporte de Validación {scheduleScore !== null ? `(Puntaje: ${scheduleScore})` : ''}</CardTitle>
                    <CardDescription>Resultados de la verificación de reglas obligatorias y flexibles.</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
                    {report.map((item, index) => (
                         <Alert key={index} variant={getAlertVariant(item.passed, item.rule)} className={cn(getAlertCustomClasses(item.passed, item.rule))}>
                            <div className="flex items-start space-x-3">
                            {getValidationIcon(item.passed, item.rule)}
                            <div>
                                <AlertTitle className="font-semibold">{item.rule}</AlertTitle>
                                {item.details && <AlertDescription className="text-sm">{item.details}</AlertDescription>}
                            </div>
                            </div>
                        </Alert>
                    ))}
                    </div>
                </CardContent>
                </Card>
            )}
        </>
       )}
    </div>
  );
}
