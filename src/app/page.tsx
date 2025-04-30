"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { generateSchedule } from '@/lib/schedule-generator';
import type { Schedule, ValidationResult, Employee, Absence, Holiday, ShiftType } from '@/types';
import { SHIFT_COLORS, TOTALS_COLOR } from '@/types';
import { cn } from "@/lib/utils";
import { format, parseISO, getDay } from 'date-fns';
import { CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';

// --- Initial Data (Based on Prompt) ---
const initialEmployees: Employee[] = [
  { id: 1, name: 'Rios', eligibleWeekend: true, preferences: {}, history: {"2025-04-27": "D", "2025-04-28": "D", "2025-04-29": "M", "2025-04-30": "M", "2025-04-31": "T"} },
  { id: 2, name: 'Molina', eligibleWeekend: true, preferences: { fixedAssignments: [{date: '2025-05-01', shift: 'M'}, {date: '2025-05-19', shift: 'T'}, {date: '2025-05-25', shift: 'M'}], fixedDaysOff: ['2025-05-17', '2025-05-18'] }, history: {"2025-04-27": "D", "2025-04-28": "D", "2025-04-29": "C", "2025-04-30": "M", "2025-04-31": "M"} },
  { id: 3, name: 'Montu', eligibleWeekend: true, preferences: {}, history: {"2025-04-27": "LAO", "2025-04-28": "LAO", "2025-04-29": "LAO", "2025-04-30": "LAO", "2025-04-31": "M"} },
  { id: 4, name: 'Cardozo', eligibleWeekend: true, preferences: { fixedAssignments: [{date: '2025-05-24', shift: 'M'}, {date: '2025-05-25', shift: 'M'}] }, history: {"2025-04-27": "M", "2025-04-28": "M", "2025-04-29": "M", "2025-04-30": "D", "2025-04-31": "D"} },
  { id: 5, name: 'Garavaglia', eligibleWeekend: true, preferences: {}, history: {"2025-04-27": "M", "2025-04-28": "M", "2025-04-29": "T", "2025-04-30": "T", "2025-04-31": "LAO"} },
  { id: 6, name: 'Forni', eligibleWeekend: true, preferences: { preferWeekendWork: true, preferMondayRest: true, preferThursdayT: true }, history: {"2025-04-27": "T", "2025-04-28": "T", "2025-04-29": "D", "2025-04-30": "M", "2025-04-31": "M"} },
  { id: 7, name: 'Alamo', eligibleWeekend: false, preferences: { fixedWorkShift: { dayOfWeek: [1, 2, 3, 4, 5], shift: 'M' } }, history: {"2025-04-27": "LM", "2025-04-28": "LM", "2025-04-29": "LM", "2025-04-30": "LM", "2025-04-31": "LM"} }
];

const absences: Absence[] = [
  { employeeId: 5, type: 'LAO', startDate: '2025-05-01', endDate: '2025-05-18' },
  { employeeId: 7, type: 'LM', startDate: '2025-05-01', endDate: '2025-05-25' },
];

const holidays: Holiday[] = [
  { date: '2025-05-01', description: 'Día del Trabajador' },
  { date: '2025-05-02', description: 'Puente Turístico' }, // Assuming 2nd is bridge holiday based on context
  { date: '2025-05-25', description: 'Día de la Revolución de Mayo' },
];

const CURRENT_YEAR = 2025;
const MONTHS = [
    { value: 1, label: 'Enero' }, { value: 2, label: 'Febrero' }, { value: 3, label: 'Marzo' },
    { value: 4, label: 'Abril' }, { value: 5, label: 'Mayo' }, { value: 6, label: 'Junio' },
    { value: 7, label: 'Julio' }, { value: 8, label: 'Agosto' }, { value: 9, label: 'Septiembre' },
    { value: 10, label: 'Octubre' }, { value: 11, label: 'Noviembre' }, { value: 12, label: 'Diciembre' }
];


export default function Home() {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [report, setReport] = useState<ValidationResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState<number>(5); // Default to May
  const [selectedYear, setSelectedYear] = useState<number>(CURRENT_YEAR); // Default to 2025

  const handleGenerateSchedule = () => {
    setIsLoading(true);
    setSchedule(null);
    setReport([]);

    // Simulate async generation for visual feedback
    setTimeout(() => {
      try {
         // NOTE: Pass a deep copy of initialEmployees to prevent mutation issues if regeneration occurs
        const result = generateSchedule(selectedYear, selectedMonth, JSON.parse(JSON.stringify(initialEmployees)), absences, holidays);
        setSchedule(result.schedule);
        setReport(result.report);
      } catch (error) {
        console.error("Error generating schedule:", error);
        // Handle error state appropriately, maybe show an error message
         setReport([{rule: "Generation Error", passed: false, details: "An unexpected error occurred during schedule generation."}]);
      } finally {
        setIsLoading(false);
      }
    }, 50); // Short delay
  };

   // Automatically generate schedule for May 2025 on initial load
   useEffect(() => {
    handleGenerateSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
   }, []); // Empty dependency array ensures this runs only once on mount


  const getDayHeaders = useMemo(() => {
    if (!schedule) return [];
    return schedule.days.map(day => {
      const date = parseISO(day.date);
      const dayOfMonth = format(date, 'd');
      const dayOfWeek = format(date, 'eee'); // Short day name (Mon, Tue, etc.)
      return { dayOfMonth, dayOfWeek, isWeekend: day.isWeekend, isHoliday: day.isHoliday };
    });
  }, [schedule]);

  const getShiftCellClass = (shift: ShiftType | null): string => {
    if (!shift) return "bg-background"; // Default background if null
    return SHIFT_COLORS[shift] || "bg-background";
  };

   const getTotalsCellClass = (): string => {
       return TOTALS_COLOR;
   }

   const getValidationIcon = (passed: boolean) => {
       if (passed) return <CheckCircle className="text-green-600 h-5 w-5" />;
       return <XCircle className="text-red-600 h-5 w-5" />;
   };

  return (
    <div className="container mx-auto p-4 md:p-8">
      <Card className="mb-8 shadow-md">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-primary">ShiftSage - Generador de Horarios</CardTitle>
          <CardDescription>Generador de horarios para el servicio de mucamas.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col md:flex-row gap-4 items-center">
           <div className="flex gap-4 w-full md:w-auto">
               <div className="flex-1">
                   <Label htmlFor="month-select">Mes</Label>
                   <Select value={selectedMonth.toString()} onValueChange={(value) => setSelectedMonth(parseInt(value))}>
                       <SelectTrigger id="month-select">
                           <SelectValue placeholder="Seleccionar mes" />
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
                   {/* Basic year input for now, could be a Select too */}
                   <Select value={selectedYear.toString()} onValueChange={(value) => setSelectedYear(parseInt(value))}>
                     <SelectTrigger id="year-select">
                       <SelectValue placeholder="Select year" />
                     </SelectTrigger>
                     <SelectContent>
                       {[CURRENT_YEAR -1 , CURRENT_YEAR, CURRENT_YEAR + 1].map(y => (
                         <SelectItem key={y} value={y.toString()}>{y}</SelectItem>
                       ))}
                     </SelectContent>
                   </Select>
               </div>
           </div>
          <Button onClick={handleGenerateSchedule} disabled={isLoading} className="w-full md:w-auto mt-4 md:mt-0">
            {isLoading ? 'Generando...' : 'Generar Horario'}
          </Button>
           {/* Optional: Add button for Excel export here */}
           {/* <Button variant="outline" disabled={!schedule || isLoading}>Exportar Excel</Button> */}
        </CardContent>
      </Card>

      {isLoading && <div className="text-center p-8"><div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-primary mx-auto"></div><p className="mt-4">Generando horario...</p></div>}

      {schedule && !isLoading && (
        <Card className="mb-8 overflow-x-auto shadow-md">
          <CardHeader>
            <CardTitle className="text-xl">Horario Generado: {MONTHS.find(m=>m.value === selectedMonth)?.label} {selectedYear}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table className="min-w-full border-collapse">
              <TableHeader>
                <TableRow className="bg-secondary">
                  <TableHead className="sticky left-0 bg-secondary z-10 border p-1 text-center font-semibold">Empleado</TableHead>
                  {getDayHeaders.map(({ dayOfMonth, dayOfWeek, isWeekend, isHoliday }, index) => (
                    <TableHead
                      key={index}
                      className={cn(
                        "border p-1 text-center text-xs font-semibold min-w-[40px]",
                        isWeekend && "bg-muted text-muted-foreground",
                        isHoliday && "bg-accent text-accent-foreground font-bold"
                      )}
                    >
                      <div>{dayOfMonth}</div>
                      <div>{dayOfWeek}</div>
                    </TableHead>
                  ))}
                  {/* Totals Columns Headers */}
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[440px] bg-secondary z-10", getTotalsCellClass())}>Trab</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[400px] bg-secondary z-10", getTotalsCellClass())}>M</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[360px] bg-secondary z-10", getTotalsCellClass())}>T</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[320px] bg-secondary z-10", getTotalsCellClass())}>S.Lib</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[280px] bg-secondary z-10", getTotalsCellClass())}>D.Lib</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[240px] bg-secondary z-10", getTotalsCellClass())}>F</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[200px] bg-secondary z-10", getTotalsCellClass())}>C</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[160px] bg-secondary z-10", getTotalsCellClass())}>D</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[120px] bg-secondary z-10", getTotalsCellClass())}>LM</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[80px] bg-secondary z-10", getTotalsCellClass())}>LAO</TableHead>
                   <TableHead className={cn("border p-1 text-center font-semibold sticky right-[0px] bg-secondary z-10", getTotalsCellClass())}>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {initialEmployees.map(emp => (
                  <TableRow key={emp.id}>
                    <TableCell className="sticky left-0 bg-background z-10 border p-1 font-medium text-sm whitespace-nowrap">{emp.name}</TableCell>
                    {schedule.days.map(day => {
                      const shift = day.shifts[emp.id];
                      return (
                        <TableCell key={`${emp.id}-${day.date}`} className={cn("border p-1 text-center text-xs font-medium", getShiftCellClass(shift))}>
                          {shift || '-'}
                        </TableCell>
                      );
                    })}
                     {/* Employee Totals */}
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[440px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.workedDays ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[400px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.M ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[360px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.T ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[320px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.freeSaturdays ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[280px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.freeSundays ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[240px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.F ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[200px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.C ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[160px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.D ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[120px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.LM ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-medium sticky right-[80px] bg-background z-10", getTotalsCellClass())}>{schedule.employeeTotals[emp.id]?.LAO ?? 0}</TableCell>
                     <TableCell className={cn("border p-1 text-center text-xs font-semibold sticky right-[0px] bg-background z-10", getTotalsCellClass())}>
                         { (schedule.employeeTotals[emp.id]?.workedDays ?? 0) +
                           (schedule.employeeTotals[emp.id]?.F ?? 0) +
                           (schedule.employeeTotals[emp.id]?.C ?? 0) +
                           (schedule.employeeTotals[emp.id]?.D ?? 0) +
                           (schedule.employeeTotals[emp.id]?.LM ?? 0) +
                           (schedule.employeeTotals[emp.id]?.LAO ?? 0)
                         }
                     </TableCell>
                  </TableRow>
                ))}
                {/* Daily Totals Rows */}
                <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                   <TableCell className="sticky left-0 z-10 border p-1 text-sm">Total Mañana (TM)</TableCell>
                   {schedule.days.map(day => <TableCell key={`TM-${day.date}`} className="border p-1 text-center text-xs">{day.totals.M}</TableCell>)}
                   <TableCell colSpan={11} className="sticky right-0 z-10 border p-1"></TableCell>
                 </TableRow>
                 <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                    <TableCell className="sticky left-0 z-10 border p-1 text-sm">Total Tarde (TT)</TableCell>
                    {schedule.days.map(day => <TableCell key={`TT-${day.date}`} className="border p-1 text-center text-xs">{day.totals.T}</TableCell>)}
                   <TableCell colSpan={11} className="sticky right-0 z-10 border p-1"></TableCell>
                 </TableRow>
                  <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                    <TableCell className="sticky left-0 z-10 border p-1 text-sm">Total Descanso (TD)</TableCell>
                    {schedule.days.map(day => <TableCell key={`TD-${day.date}`} className="border p-1 text-center text-xs">{day.totals.D}</TableCell>)}
                   <TableCell colSpan={11} className="sticky right-0 z-10 border p-1"></TableCell>
                 </TableRow>
                  <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                    <TableCell className="sticky left-0 z-10 border p-1 text-sm">Total Feriado (TF)</TableCell>
                    {schedule.days.map(day => <TableCell key={`TF-${day.date}`} className="border p-1 text-center text-xs">{day.totals.F}</TableCell>)}
                   <TableCell colSpan={11} className="sticky right-0 z-10 border p-1"></TableCell>
                 </TableRow>
                  <TableRow className={cn("font-semibold", getTotalsCellClass())}>
                    <TableCell className="sticky left-0 z-10 border p-1 text-sm">Total Compensat. (TC)</TableCell>
                    {schedule.days.map(day => <TableCell key={`TC-${day.date}`} className="border p-1 text-center text-xs">{day.totals.C}</TableCell>)}
                    <TableCell colSpan={11} className="sticky right-0 z-10 border p-1"></TableCell>
                 </TableRow>
                  <TableRow className={cn("font-bold", getTotalsCellClass())}>
                    <TableCell className="sticky left-0 z-10 border p-1 text-sm">TOTAL PERSONAL (TPT)</TableCell>
                    {schedule.days.map(day => <TableCell key={`TPT-${day.date}`} className={cn("border p-1 text-center text-xs", (day.totals.TPT < 2 || (!day.isHoliday && !day.isWeekend && day.totals.TPT > 2 && day.totals.M <= day.totals.T)) && "bg-destructive text-destructive-foreground font-bold")}>{day.totals.TPT}</TableCell>)}
                   <TableCell colSpan={11} className="sticky right-0 z-10 border p-1"></TableCell>
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
                 <Alert key={index} variant={item.passed ? 'default' : (item.rule.startsWith("Flexible") ? 'default' : 'destructive')} className={cn(item.passed ? "border-green-200" : (item.rule.startsWith("Flexible") ? "border-amber-300" : "border-red-200") )}>
                    <div className="flex items-start space-x-3">
                       {item.passed ? <CheckCircle className="text-green-500 h-5 w-5 mt-1"/> : (item.rule.startsWith("Flexible") ? <Info className="text-amber-500 h-5 w-5 mt-1"/> : <XCircle className="text-red-500 h-5 w-5 mt-1"/>)}
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
    </div>
  );
}
