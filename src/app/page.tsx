
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
import { generateSchedule, calculateFinalTotals, validateSchedule } from '@/lib/schedule-generator';
import type { Schedule, ValidationResult, Employee, Absence, Holiday, ShiftType, TargetStaffing } from '@/types';
import { SHIFT_TYPES, SHIFT_COLORS, TOTALS_COLOR, ALLOWED_FIXED_ASSIGNMENT_SHIFTS } from '@/types';
import { cn } from "@/lib/utils";
import { format, parseISO, getDay, getDaysInMonth, addDays, subDays, startOfMonth, endOfMonth, isValid } from 'date-fns';
import { CheckCircle, XCircle, AlertTriangle, Info, PlusCircle, Trash2, Edit, Save, Settings, ArrowLeft, Download } from 'lucide-react'; // Added Download icon
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';

// --- Initial Data (Now defaults, user can modify) ---
const defaultEmployees: Employee[] = [
    { id: 1, name: 'Rios', eligibleWeekend: true, preferences: {}, history: {} },
    { id: 2, name: 'Molina', eligibleWeekend: true, preferences: {}, history: {} },
    { id: 3, name: 'Montu', eligibleWeekend: true, preferences: {}, history: {} },
    { id: 4, name: 'Cardozo', eligibleWeekend: true, preferences: {}, history: {} },
    { id: 5, name: 'Garavaglia', eligibleWeekend: true, preferences: {}, history: {} },
    { id: 6, name: 'Forni', eligibleWeekend: true, preferences: {}, history: {} },
    { id: 7, name: 'Alamo', eligibleWeekend: false, preferences: { fixedWorkShift: { dayOfWeek: [1, 2, 3, 4, 5], shift: 'M' } }, history: {} }
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
        shift: z.enum(ALLOWED_FIXED_ASSIGNMENT_SHIFTS as [string, ...string[]])
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

// --- Component ---
export default function Home() {
  const [displayMode, setDisplayMode] = useState<'config' | 'viewing'>('config');
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [report, setReport] = useState<ValidationResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [isDateInitialized, setIsDateInitialized] = useState(false);

  // Target Staffing State
  const [targetMWorkday, setTargetMWorkday] = useState<number>(3);
  const [targetTWorkday, setTargetTWorkday] = useState<number>(1);
  const [targetMWeekendHoliday, setTargetMWeekendHoliday] = useState<number>(2);
  const [targetTWeekendHoliday, setTargetTWeekendHoliday] = useState<number>(1);


  useEffect(() => {
    const now = new Date();
    setSelectedMonth(now.getMonth() + 1);
    setSelectedYear(now.getFullYear());
    setIsDateInitialized(true);
  }, []);


  const [employees, setEmployees] = useState<Employee[]>(defaultEmployees.map(emp => ({...emp, preferences: emp.preferences || {}})));
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
    setAbsences(prev => prev.filter(a => a.employeeId !== id));
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
     setAbsences(prev => prev.map(a => a.id === editingAbsence.id ? { ...a, ...data } : a));
     setIsAbsenceDialogOpen(false);
     setEditingAbsence(null);
     absenceForm.reset();
   }

  const handleDeleteAbsence = (id: number) => {
      setAbsences(prev => prev.filter(a => a.id !== id));
  };

  const handleAddHoliday = (data: z.infer<typeof holidaySchema>) => {
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
    return dates.sort().reverse();
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

  const handleGenerateSchedule = () => {
    if (!isDateInitialized || selectedMonth === null || selectedYear === null) {
        console.warn("Month or year not initialized yet.");
        return;
    }
    setIsLoading(true);
    setSchedule(null);
    setReport([]);
    setDisplayMode('viewing');

    const employeesWithHistory = employees.map(emp => ({
      ...emp,
      history: historyInputs[emp.id] || {},
      consecutiveWorkDays: 0
    }));


     if (employeesWithHistory.length === 0) {
       setReport([{ rule: "Error de Entrada", passed: false, details: "No hay empleados definidos." }]);
       setIsLoading(false);
       return;
     }
     if (isNaN(selectedYear) || isNaN(selectedMonth) || selectedMonth < 1 || selectedMonth > 12) {
         setReport([{ rule: "Error de Entrada", passed: false, details: "Mes o año inválido." }]);
         setIsLoading(false);
         return;
     }
    
    const currentTargetStaffing: TargetStaffing = {
        workdayMorning: targetMWorkday,
        workdayAfternoon: targetTWorkday,
        weekendHolidayMorning: targetMWeekendHoliday,
        weekendHolidayAfternoon: targetTWeekendHoliday,
    };

    setTimeout(() => {
      try {
        const result = generateSchedule(
          selectedYear,
          selectedMonth,
          JSON.parse(JSON.stringify(employeesWithHistory)),
          JSON.parse(JSON.stringify(absences)),
          JSON.parse(JSON.stringify(holidays)),
          currentTargetStaffing
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
            setReport([]); // Clear report as it's now potentially invalid
        }
    };

    const handleRecalculate = () => {
        if (!schedule) return;
        setIsLoading(true);
        setReport([]);
         const scheduleToRecalculate = JSON.parse(JSON.stringify(schedule));
         const currentTargetStaffing: TargetStaffing = {
            workdayMorning: targetMWorkday,
            workdayAfternoon: targetTWorkday,
            weekendHolidayMorning: targetMWeekendHoliday,
            weekendHolidayAfternoon: targetTWeekendHoliday,
        };

         setTimeout(() => {
             try {
                calculateFinalTotals(scheduleToRecalculate, employees, absences);
                const newReport = validateSchedule(scheduleToRecalculate, employees, absences, holidays, currentTargetStaffing);
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

    // Headers
    const dayNumbers = schedule.days.map(day => format(parseISO(day.date), 'd'));
    const headerRow = ["Empleado", "Total D", "Total M", "Total T", ...dayNumbers].join(",");
    csvContent += headerRow + "\r\n";

    // Employee Rows
    employees.forEach(emp => {
        const totals = schedule.employeeTotals[emp.id] || { D: 0, M: 0, T: 0 };
        const shifts = schedule.days.map(day => day.shifts[emp.id] || "").join(",");
        const employeeRow = [emp.name, totals.D, totals.M, totals.T, shifts].join(",");
        csvContent += employeeRow + "\r\n";
    });

    // Separator
    csvContent += "\r\n"; 

    // Daily Totals Rows
    const dailyTotalsM = schedule.days.map(day => day.totals.M).join(",");
    const dailyTotalsT = schedule.days.map(day => day.totals.T).join(",");
    const dailyTotalsTPT = schedule.days.map(day => day.totals.TPT).join(",");

    csvContent += ["Total Mañana (TM)", "", "", "", ...schedule.days.map(day => day.totals.M)].join(",") + "\r\n";
    csvContent += ["Total Tarde (TT)", "", "", "", ...schedule.days.map(day => day.totals.T)].join(",") + "\r\n";
    csvContent += ["TOTAL PERSONAL (TPT)", "", "", "", ...schedule.days.map(day => day.totals.TPT)].join(",") + "\r\n";
    
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
        const dayOfWeek = format(date, 'eee');
        return { dayOfMonth, dayOfWeek, isWeekend: day.isWeekend, isHoliday: day.isHoliday };
      } catch (e) {
        console.error(`Error parsing date: ${day.date}`, e);
        return { dayOfMonth: 'Err', dayOfWeek: 'Err', isWeekend: false, isHoliday: false };
      }
    });
  }, [schedule]);

  const getShiftCellClass = (shift: ShiftType | null): string => {
    if (!shift) return "bg-background";
    return SHIFT_COLORS[shift] || "bg-background";
  };

   const getTotalsCellClass = (): string => {
       return TOTALS_COLOR;
   }

   const getValidationIcon = (passed: boolean, rule: string) => {
       if (passed) return <CheckCircle className="text-green-600 h-5 w-5" />;
       if (rule.startsWith("Flexible") || rule.startsWith("Preferencia Flexible") || rule.startsWith("Info Generador") || rule.startsWith("Potencial") || rule.startsWith("Generator Info")) {
            return <Info className="text-yellow-600 h-5 w-5" />;
       }
       return <XCircle className="text-red-600 h-5 w-5" />;
   };

    const daysOfWeekOptions = [
        { value: 1, label: 'Lunes' }, { value: 2, label: 'Martes' }, { value: 3, label: 'Miércoles' },
        { value: 4, label: 'Jueves' }, { value: 5, label: 'Viernes' }, { value: 6, label: 'Sábado' },
        { value: 0, label: 'Domingo' }
    ];

     const manualShiftOptions = ['NULL', ...SHIFT_TYPES].map(opt => ({value: opt, label: opt === 'NULL' ? '-' : opt }));


  return (
    <div className="container mx-auto p-4 md:p-8">
       {displayMode === 'config' && (
            <Card className="mb-8 shadow-md">
                <CardHeader>
                <CardTitle className="text-2xl font-bold text-primary">ShiftSage - Configuración</CardTitle>
                <CardDescription>Configure los parámetros para la generación del horario.</CardDescription>
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
                    <Button onClick={handleGenerateSchedule} disabled={isLoading || !isDateInitialized} className="w-full md:w-auto">
                        {isLoading ? 'Generando...' : 'Generar Horario'}
                    </Button>
                </div>
                
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg font-medium">Dotación Objetivo</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                                <Label htmlFor="targetMWorkday">Mañanas (L-V)</Label>
                                <Input id="targetMWorkday" type="number" value={targetMWorkday} onChange={(e) => setTargetMWorkday(parseInt(e.target.value) || 0)} min="0" />
                            </div>
                            <div>
                                <Label htmlFor="targetTWorkday">Tardes (L-V)</Label>
                                <Input id="targetTWorkday" type="number" value={targetTWorkday} onChange={(e) => setTargetTWorkday(parseInt(e.target.value) || 0)} min="0" />
                            </div>
                            <div>
                                <Label htmlFor="targetMWeekendHoliday">Mañanas (S,D,Feriado)</Label>
                                <Input id="targetMWeekendHoliday" type="number" value={targetMWeekendHoliday} onChange={(e) => setTargetMWeekendHoliday(parseInt(e.target.value) || 0)} min="0" />
                            </div>
                            <div>
                                <Label htmlFor="targetTWeekendHoliday">Tardes (S,D,Feriado)</Label>
                                <Input id="targetTWeekendHoliday" type="number" value={targetTWeekendHoliday} onChange={(e) => setTargetTWeekendHoliday(parseInt(e.target.value) || 0)} min="0" />
                            </div>
                        </div>
                    </CardContent>
                </Card>


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
                                                                        {ALLOWED_FIXED_ASSIGNMENT_SHIFTS.map(st => <SelectItem key={st} value={st}>{st}</SelectItem>)}
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
                                                                            const currentShift = field.value?.shift ?? 'M';
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
                                                                {ALLOWED_FIXED_ASSIGNMENT_SHIFTS.filter(s => s === 'M' || s === 'T' || s === 'D').map(st => <SelectItem key={st} value={st}>{st}</SelectItem>)}
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
                                    {employees.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No hay empleados definidos.</p>}
                                </ul>
                                <div className="mt-4 space-y-4 border-t pt-4">
                                    <h4 className="text-md font-semibold">Historial (Últimos 5 días Mes Anterior)</h4>
                                    {employees.map(emp => (
                                        <div key={`hist-${emp.id}`} className="space-y-1">
                                            <p className="text-sm font-medium">{emp.name}</p>
                                            <div className="grid grid-cols-3 gap-2">
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
                                                                {SHIFT_TYPES.map(st => (
                                                                    <SelectItem key={st} value={st}>{st}</SelectItem>
                                                                ))}
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
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
                                        <Button size="sm" variant="outline" onClick={() => { setEditingAbsence(null); absenceForm.reset(); setIsAbsenceDialogOpen(true); }}>
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
                    <div className="flex justify-between items-center">
                        <div>
                             <CardTitle className="text-xl">Horario Generado: {MONTHS.find(m=>m.value === selectedMonth)?.label} {selectedYear}</CardTitle>
                             <CardDescription>Puedes editar los turnos manualmente en la tabla. Usa "Recalcular" para actualizar totales y validaciones.</CardDescription>
                        </div>
                         <div className="flex gap-2">
                            <Button variant="outline" onClick={() => setDisplayMode('config')}><ArrowLeft className="mr-2 h-4 w-4"/> Volver a Configuración</Button>
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
                        <TableHead className="sticky left-0 bg-secondary z-20 border p-1 text-center font-semibold min-w-[170px] w-[170px]">Empleado</TableHead>
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
                            <TableCell className="sticky left-0 bg-background z-10 border p-1 font-medium text-sm whitespace-nowrap min-w-[170px] w-[170px]">{emp.name}</TableCell>
                            <TableCell className={cn("sticky left-[170px] bg-background z-10 border p-1 text-center text-xs font-medium min-w-[60px] w-[60px]", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.D ?? 0}</TableCell>

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
                        <TableCell className="sticky left-0 z-10 border p-1 text-sm min-w-[170px] w-[170px]">Total Mañana (TM)</TableCell>
                        <TableCell className={cn("sticky left-[170px] z-10 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                        {schedule.days.map(day => <TableCell key={`TM-${day.date}`} className="border p-1 text-center text-xs">{day.totals.M}</TableCell>)}
                        </TableRow>
                        <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                            <TableCell className="sticky left-0 z-10 border p-1 text-sm min-w-[170px] w-[170px]">Total Tarde (TT)</TableCell>
                            <TableCell className={cn("sticky left-[170px] z-10 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                            {schedule.days.map(day => <TableCell key={`TT-${day.date}`} className="border p-1 text-center text-xs">{day.totals.T}</TableCell>)}
                        </TableRow>
                         <TableRow className={cn("font-bold", getTotalsCellClass())}>
                            <TableCell className="sticky left-0 z-10 border p-1 text-sm min-w-[170px] w-[170px]">TOTAL PERSONAL (TPT)</TableCell>
                             <TableCell className={cn("sticky left-[170px] z-10 border p-1 text-sm min-w-[60px] w-[60px]", getTotalsCellClass())}></TableCell>
                            {schedule.days.map(day => <TableCell key={`TPT-${day.date}`} className={cn("border p-1 text-center text-xs", (day.totals.TPT < 2 || (!day.isHoliday && !day.isWeekend && day.totals.TPT > 2 && day.totals.M <= day.totals.T)) && "bg-destructive text-destructive-foreground font-bold")}>{day.totals.TPT}</TableCell>)}
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
                         <Alert key={index} variant={item.passed ? 'default' : (item.rule.startsWith("Flexible") || item.rule.startsWith("Preferencia Flexible") || item.rule.startsWith("Info Generador") || item.rule.startsWith("Potencial") ? 'default' : 'destructive')} className={cn(item.passed ? "border-green-200" : (item.rule.startsWith("Flexible") || item.rule.startsWith("Preferencia Flexible") || item.rule.startsWith("Info Generador") || item.rule.startsWith("Potencial") ? "border-yellow-300" : "border-red-200") )}>
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

