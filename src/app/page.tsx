
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
import { Textarea } from "@/components/ui/textarea";
import { generateSchedule, calculateFinalTotals, validateSchedule, initializeSchedule as initializeScheduleLib } from '@/lib/schedule-generator';
import type { Schedule, ValidationResult, Employee, Absence, Holiday, ShiftType, TargetStaffing, OperationalRules } from '@/types';
import { SHIFT_TYPES, SHIFT_COLORS, TOTALS_COLOR, ALLOWED_FIXED_ASSIGNMENT_SHIFTS } from '@/types';
import { cn } from "@/lib/utils";
import { format, parseISO, getDay, getDaysInMonth, addDays, subDays, startOfMonth, endOfMonth, isValid, getMonth, getYear as getFullYear } from 'date-fns';
import { es } from 'date-fns/locale';
import { CheckCircle, XCircle, AlertTriangle, Info, PlusCircle, Trash2, Edit, Save, Settings, ArrowLeft, Download, Upload } from 'lucide-react';
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useToast } from "@/hooks/use-toast";

// --- Initial Data (Now defaults, user can modify or import) ---
const defaultInitialEmployees: Employee[] = [
    // This list can be initially empty or have some defaults,
    // but will be overwritten by CSV import if that feature is used.
];

const HISTORY_CSV_HEADER_TOKEN = "HISTORIAL_MES_ANTERIOR_EMPLEADO";

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
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [report, setReport] = useState<ValidationResult[]>([]);
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
    setAbsences(prev => [...prev, { ...data, id: Date.now() }]);
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
     setAbsences(prev => prev.map(a => a.id === editingAbsence.id ? { ...a, ...data } : a));
     setIsAbsenceDialogOpen(false);
     setEditingAbsence(null);
     absenceForm.reset();
   }

  const handleDeleteAbsence = (id: number) => {
      setAbsences(prev => prev.filter(a => a.id !== id));
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
        const firstDayColumnIndex = 5; // Shifts start after "Empleado", "Total D", "Total M", "Total T", "Total N"

        const loadedEmployees: Employee[] = [];
        const loadedHistoryInputs: { [employeeId: number]: { [date: string]: ShiftType | null } } = {};
        const previousDatesForHistory = getPreviousMonthDates(); // Relies on selectedMonth/Year

        let employeesProcessedFromCsv = 0;

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          const cells = line.split(',');
          const employeeNameFromCSV = cells[employeeNameIndex]?.trim();

          if (!employeeNameFromCSV ||
              employeeNameFromCSV.toLowerCase().startsWith("total mañana") ||
              employeeNameFromCSV.toLowerCase().startsWith("total tarde") ||
              employeeNameFromCSV.toLowerCase().startsWith("total noche") ||
              employeeNameFromCSV.toLowerCase().startsWith("total personal") ||
              employeeNameFromCSV.toLowerCase().startsWith(HISTORY_CSV_HEADER_TOKEN.toLowerCase())
              ) {
            break; // Stop processing at summary rows or history section
          }

          employeesProcessedFromCsv++;

          let employeeInLoadedList = loadedEmployees.find(emp => emp.name.trim().toLowerCase() === employeeNameFromCSV.toLowerCase());

          if (!employeeInLoadedList) {
            employeeInLoadedList = {
                id: Date.now() + loadedEmployees.length, // Generate new ID
                name: employeeNameFromCSV,
                eligibleWeekend: true, // Default value
                preferences: {},       // Default value
                history: {},           // This will be populated by the history import logic
            };
            loadedEmployees.push(employeeInLoadedList);
          }

          // Populate history for this employee (newly created or found)
          if (previousDatesForHistory.length > 0) {
            const dailyShiftsFromCSV = cells.slice(firstDayColumnIndex);
            const numHistoryDaysToTake = previousDatesForHistory.length;
            // Take the *last* N shifts from the CSV for history
            const relevantShiftsFromCSV = dailyShiftsFromCSV.slice(-numHistoryDaysToTake);

            if (relevantShiftsFromCSV.length > 0) {
                if (!loadedHistoryInputs[employeeInLoadedList.id]) {
                    loadedHistoryInputs[employeeInLoadedList.id] = {};
                }
                previousDatesForHistory.forEach((dateStr, index) => {
                    if (index < relevantShiftsFromCSV.length) {
                        const shiftValue = relevantShiftsFromCSV[index]?.trim();
                        if (shiftValue === 'N' && !isNightShiftEnabled) {
                            loadedHistoryInputs[employeeInLoadedList.id][dateStr] = null;
                        } else if (shiftValue && SHIFT_TYPES.includes(shiftValue as ShiftType)) {
                            loadedHistoryInputs[employeeInLoadedList.id][dateStr] = shiftValue as ShiftType;
                        } else if (shiftValue === '' || shiftValue === '-') {
                            loadedHistoryInputs[employeeInLoadedList.id][dateStr] = null;
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

        setEmployees(loadedEmployees);
        setHistoryInputs(loadedHistoryInputs);
        setAbsences([]); // Clear absences as employee list and IDs have changed

        if (loadedEmployees.length > 0) {
            const historyMessage = previousDatesForHistory.length > 0 ? `El historial de los últimos ${previousDatesForHistory.length} días también fue importado (si estaba disponible).` : "No se importó historial (mes/año no configurado para historial o CSV sin datos suficientes).";
            toast({ title: "Importación Exitosa", description: `${loadedEmployees.length} empleado(s) cargado(s) desde el CSV. ${historyMessage}` });
        } else if (employeesProcessedFromCsv > 0) {
             toast({ title: "Importación Parcial", description: `Se procesaron ${employeesProcessedFromCsv} filas de empleados del CSV, pero no se cargaron nuevos empleados (posiblemente duplicados o formato incorrecto).`, variant: "default" });
        } else {
            toast({ title: "Sin Empleados Cargados", description: "No se encontraron datos de empleados válidos en el archivo CSV para cargar.", variant: "default" });
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

        // --- Parse Main Schedule Section ---
        const headerCells = lines[0].split(',');
        const employeeNameColIndex = headerCells.findIndex(h => h.trim().toLowerCase() === 'empleado');
        if (employeeNameColIndex === -1) throw new Error("Columna 'Empleado' no encontrada en el CSV.");

        const daysInSelectedMonth = getDaysInMonth(new Date(selectedYear, selectedMonth - 1));
        const firstShiftColIndex = isNightShiftEnabled ? 5 : 4; // After Empleado, Total D, Total M, Total T, [Total N if enabled]
        const csvDayHeaders = headerCells.slice(firstShiftColIndex, firstShiftColIndex + daysInSelectedMonth);

        if (csvDayHeaders.length !== daysInSelectedMonth) {
          throw new Error(`El número de días en el CSV (${csvDayHeaders.length}) no coincide con los días del mes seleccionado (${daysInSelectedMonth}).`);
        }
        
        const loadedEmployeesFromMainSchedule: Employee[] = [];
        const newSchedule = initializeScheduleLib(selectedYear, selectedMonth, [], holidays, isNightShiftEnabled); // Initialize with empty employees first
        
        let scheduleSectionEndIndex = lines.findIndex(line => line.toLowerCase().startsWith("total mañana"));
        if (scheduleSectionEndIndex === -1) scheduleSectionEndIndex = lines.length; // If no totals, parse all lines

        for (let i = 1; i < scheduleSectionEndIndex; i++) {
            const cells = lines[i].split(',');
            const csvEmployeeName = cells[employeeNameColIndex]?.trim();
            if (!csvEmployeeName) continue;

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
              const csvShift = cells[firstShiftColIndex + dayIdx]?.trim();
              if (csvShift === 'N' && !isNightShiftEnabled) {
                newSchedule.days[dayIdx].shifts[newEmployee.id] = null;
              } else if (csvShift && SHIFT_TYPES.includes(csvShift as ShiftType)) {
                newSchedule.days[dayIdx].shifts[newEmployee.id] = csvShift as ShiftType;
              } else if (csvShift === '' || csvShift === '-') {
                newSchedule.days[dayIdx].shifts[newEmployee.id] = null;
              }
            }
        }
        setEmployees(loadedEmployeesFromMainSchedule);


        // --- Parse History Section (if exists) ---
        let historyLoaded = false;
        const newHistoryInputs: { [employeeId: number]: { [date: string]: ShiftType | null } } = {};
        const historySectionStartIndex = lines.findIndex(line => line.startsWith(HISTORY_CSV_HEADER_TOKEN));

        if (historySectionStartIndex !== -1) {
            const historyHeaderLine = lines[historySectionStartIndex];
            const historyHeaderCells = historyHeaderLine.split(';'); // Assuming semicolon separated for history header
            const historyDateHeaders = historyHeaderCells.slice(1); // Skip token

            for (let i = historySectionStartIndex + 1; i < lines.length; i++) {
                const historyLine = lines[i];
                if (!historyLine.trim() || historyLine.toLowerCase().startsWith("total")) break; // End of history data

                const historyCells = historyLine.split(','); // Main schedule is comma, history data might be too
                const csvEmployeeName = historyCells[0]?.trim();
                const employeeInApp = loadedEmployeesFromMainSchedule.find(emp => emp.name.trim().toLowerCase() === csvEmployeeName.toLowerCase());

                if (employeeInApp) {
                    if (!newHistoryInputs[employeeInApp.id]) {
                        newHistoryInputs[employeeInApp.id] = {};
                    }
                    historyDateHeaders.forEach((dateStr, index) => {
                        const shiftValue = historyCells[index + 1]?.trim(); // +1 because first cell is name
                        if (shiftValue === 'N' && !isNightShiftEnabled) {
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

        if (loadedEmployeesFromMainSchedule.length === 0) {
          throw new Error("No se encontraron empleados válidos en la sección principal del horario del CSV.");
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

        calculateFinalTotals(newSchedule, loadedEmployeesFromMainSchedule, absences, isNightShiftEnabled); // Use loaded employees
        const newReport = validateSchedule(newSchedule, loadedEmployeesFromMainSchedule, absences, holidays, currentTargetStaffing, maxConsecutiveWork, maxConsecutiveRest, currentOperationalRules, isNightShiftEnabled);

        setSchedule(newSchedule);
        setReport(newReport);
        setDisplayMode('viewing');
        let toastDescription = `Horario importado para ${loadedEmployeesFromMainSchedule.length} empleado(s).`;
        if (historyLoaded) {
            toastDescription += " El historial del mes anterior también fue cargado desde el archivo.";
        } else {
            toastDescription += " No se encontró sección de historial en el archivo, o no contenía datos.";
        }
        toast({ title: "Horario Cargado", description: toastDescription });


      } catch (error) {
        console.error("Error importando horario completo desde CSV:", error);
        toast({ title: "Error de Importación", description: error instanceof Error ? error.message : "Ocurrió un error procesando el archivo CSV del horario.", variant: "destructive" });
        setSchedule(null);
        setReport([]);
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
        setDisplayMode('config'); // Stay in config mode
        return;
    }
    setIsLoading(true);
    setSchedule(null);
    setReport([]);


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

    setDisplayMode('viewing');

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
          isNightShiftEnabled
        );
        setSchedule(result.schedule);
        setReport(result.report);
      } catch (error) {
        console.error("Error generating schedule:", error);
        setReport([{rule: "Error de Generación", passed: false, details: `Error inesperado: ${error instanceof Error ? error.message : 'Error desconocido'}`}]);
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
                const newReport = validateSchedule(scheduleToRecalculate, employees, absences, holidays, currentTargetStaffing, maxConsecutiveWork, maxConsecutiveRest, currentOperationalRules, isNightShiftEnabled);
                setSchedule(scheduleToRecalculate);
                setReport(newReport);
            } catch (error) {
                console.error("Error during recalculation:", error);
                setReport([{rule: "Error de Recálculo", passed: false, details: `Error inesperado: ${error instanceof Error ? error.message : 'Error desconocido'}`}]);
            } finally {
                 setIsLoading(false);
            }
         }, 50)
    }

  const exportScheduleToCSV = () => {
    if (!schedule || !employees || selectedMonth === null || selectedYear === null) return;

    const monthName = MONTHS.find(m => m.value === selectedMonth)?.label.toUpperCase() || 'MesDesconocido';
    const fileName = `horario_${monthName}_${selectedYear}.csv`;

    let csvContent = "data:text/csv;charset=utf-8,";

    const dayNumbers = schedule.days.map(day => format(parseISO(day.date), 'd'));
    const headerBase = ["Empleado", "Total D", "Total M", "Total T"];
    if (isNightShiftEnabled) headerBase.push("Total N");
    const headerRow = [...headerBase, ...dayNumbers].join(",");
    csvContent += headerRow + "\r\n";

    employees.forEach(emp => {
        const totals = schedule.employeeTotals[emp.id] || { D: 0, M: 0, T: 0, N: 0, F: 0, C: 0, LAO: 0, LM: 0, workedDays: 0, freeSaturdays: 0, freeSundays: 0 };
        const shifts = schedule.days.map(day => day.shifts[emp.id] || "").join(",");
        const employeeRowBase = [emp.name, totals.D, totals.M, totals.T];
        if(isNightShiftEnabled) employeeRowBase.push(totals.N);
        const employeeRow = [...employeeRowBase, shifts].join(",");
        csvContent += employeeRow + "\r\n";
    });

    csvContent += "\r\n";

    const emptyTotalCells = isNightShiftEnabled ? ["", "", "", "", ""] : ["", "", "", ""];
    csvContent += ["Total Mañana (TM)", ...emptyTotalCells, ...schedule.days.map(day => day.totals.M)].join(",") + "\r\n";
    csvContent += ["Total Tarde (TT)", ...emptyTotalCells, ...schedule.days.map(day => day.totals.T)].join(",") + "\r\n";
    if (isNightShiftEnabled) {
        csvContent += ["Total Noche (TN)", ...emptyTotalCells, ...schedule.days.map(day => day.totals.N)].join(",") + "\r\n";
    }
    csvContent += ["TOTAL PERSONAL (TPT)", ...emptyTotalCells, ...schedule.days.map(day => day.totals.TPT)].join(",") + "\r\n";

    // Add history section
    const previousDatesForHistory = getPreviousMonthDates();
    if (previousDatesForHistory.length > 0 && Object.keys(historyInputs).length > 0) {
        csvContent += "\r\n\r\n"; // Extra blank lines for separation
        const historyHeaderCells = [HISTORY_CSV_HEADER_TOKEN, ...previousDatesForHistory.map(d => format(parseISO(d), 'dd/MM/yyyy'))];
        csvContent += historyHeaderCells.join(";") + "\r\n"; // Use semicolon for this distinct header for easier parsing

        employees.forEach(emp => {
            const empHistory = historyInputs[emp.id] || {};
            const historyRowValues = previousDatesForHistory.map(dateStr => empHistory[dateStr] || "");
            csvContent += [emp.name, ...historyRowValues].join(",") + "\r\n";
        });
    }

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", fileName);
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
       if (passed) return <CheckCircle className="text-green-600 h-5 w-5" />;
       if (rule.startsWith("Flexible") || rule.startsWith("Preferencia Flexible") || rule.startsWith("Info Generador") || rule.startsWith("Potencial") || rule.startsWith("Generator Info") || rule.startsWith("Prioridad 2 Info")) {
            return <Info className="text-yellow-600 h-5 w-5" />;
       }
       return <XCircle className="text-red-600 h-5 w-5" />;
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


  return (
    <div className="container mx-auto p-4 md:p-8">
       {displayMode === 'config' && (
            <Card className="mb-8 shadow-md">
                <CardHeader>
                <CardTitle className="text-2xl font-bold text-primary">Ayuda horarios - Configuración</CardTitle>
                <CardDescription>Configure los parámetros para la generación del horario o cargue uno existente.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex flex-col md:flex-row gap-4 items-end">
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
                            <Button onClick={handleGenerateSchedule} disabled={isLoading || !isDateInitialized || !selectedMonth || !selectedYear} className="flex-1">
                                {isLoading ? 'Generando...' : 'Generar Horario'}
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => document.getElementById('fullScheduleImportInput')?.click()}
                                disabled={isLoading || !isDateInitialized || !selectedMonth || !selectedYear}
                                className="flex-1"
                            >
                                <Upload className="mr-2 h-4 w-4" /> Cargar Horario CSV
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
                                                                            const currentShift = field.value?.shift ?? (isNightShiftEnabled ? 'M' : 'M'); // Default if N disabled
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
                                    <h4 className="text-md font-semibold">Importar Lista de Empleados e Historial (Últimos 5 días Mes Anterior)</h4>
                                     <Button type="button" variant="outline" size="sm" onClick={() => document.getElementById('csvImportInput')?.click()} className="mb-2 w-full">
                                        <Upload className="mr-2 h-4 w-4" /> Importar Empleados e Historial CSV
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
                            <Button variant="outline" onClick={() => { setSchedule(null); setReport([]); setDisplayMode('config');}}><ArrowLeft className="mr-2 h-4 w-4"/> Volver a Configuración</Button>
                             <Button onClick={handleRecalculate} disabled={isLoading}>Recalcular Totales y Validar</Button>
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
                        <TableHead className={cn("sticky left-[170px] bg-secondary z-20 border p-1 text-center font-semibold min-w-[60px] w-[60px]")}>D</TableHead>

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
                            <TableCell className={cn("sticky left-[170px] bg-background z-20 border p-1 text-center text-xs font-medium min-w-[60px] w-[60px]")}>{schedule.employeeTotals[emp.id]?.D ?? 0}</TableCell>

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
                        <TableCell className={cn("sticky left-0 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>Total Mañana (TM)</TableCell>
                        <TableCell className={cn("sticky left-[170px] z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                        {schedule.days.map(day => <TableCell key={`TM-${day.date}`} className="border p-1 text-center text-xs">{day.totals.M}</TableCell>)}
                        </TableRow>
                        <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                            <TableCell className={cn("sticky left-0 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>Total Tarde (TT)</TableCell>
                            <TableCell className={cn("sticky left-[170px] z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                            {schedule.days.map(day => <TableCell key={`TT-${day.date}`} className="border p-1 text-center text-xs">{day.totals.T}</TableCell>)}
                        </TableRow>
                         {isNightShiftEnabled && (
                            <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                                <TableCell className={cn("sticky left-0 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>Total Noche (TN)</TableCell>
                                <TableCell className={cn("sticky left-[170px] z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                                {schedule.days.map(day => <TableCell key={`TN-${day.date}`} className="border p-1 text-center text-xs">{day.totals.N}</TableCell>)}
                            </TableRow>
                         )}
                         <TableRow className={cn("font-bold", getTotalsCellClass())}>
                            <TableCell className={cn("sticky left-0 z-30 border p-1 text-sm min-w-[170px] w-[170px]", getTotalsCellClass())}>TOTAL PERSONAL (TPT)</TableCell>
                             <TableCell className={cn("sticky left-[170px] z-20 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
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
                    <CardTitle className="text-xl">Reporte de Validación</CardTitle>
                    <CardDescription>Resultados de la verificación de reglas obligatorias y flexibles.</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
                    {report.map((item, index) => (
                         <Alert key={index} variant={item.passed ? 'default' : (item.rule.startsWith("Flexible") || item.rule.startsWith("Preferencia Flexible") || item.rule.startsWith("Info Generador") || item.rule.startsWith("Potencial") || item.rule.startsWith("Generator Info") || item.rule.startsWith("Prioridad 2 Info") ? 'default' : 'destructive')} className={cn(item.passed ? "border-green-200" : (item.rule.startsWith("Flexible") || item.rule.startsWith("Preferencia Flexible") || item.rule.startsWith("Info Generador") || item.rule.startsWith("Potencial") || item.rule.startsWith("Generator Info") || item.rule.startsWith("Prioridad 2 Info") ? "border-yellow-300" : "border-red-200") )}>
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
