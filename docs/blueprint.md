# **App Name**: ShiftSage

## Core Features:

- Schedule Display: Display the generated schedule in a clear, responsive HTML table, with color-coding for different shifts (M, T, D, etc.) as specified. Show daily and per-person totals.
- Schedule Generation: Implement the core scheduling logic to generate a monthly schedule based on the given rules (prioritized), employee availability, and constraints. This will be implemented in Javascript running in the browser. Note that this MVP will NOT involve using a database, so any scheduling history will be lost when the browser is refreshed.
- Report and Parameter Input: Provide a simple form to input the schedule generation parameters and show a report summarizing whether or not all the rules were met, and list any violations. This will be a simple UI made from HTML.

## Style Guidelines:

- Primary color: A calm teal (#26A69A) for a professional and reliable feel.
- Secondary color: Light grey (#EEEEEE) for backgrounds and neutral elements.
- Accent: A warm amber (#FFC107) for important alerts, rule violations and highlights.
- Clean, table-based layout for schedule presentation.
- Simple, consistent icons for different shift types (M, T, D).
- Subtle transitions for loading and updating the schedule.

## Original User Request:
Rol: Actúa como un desarrollador full-stack experto, especializado en la creación de aplicaciones web con Python (Flask/Django) y bases de datos PostgreSQL, con experiencia en la implementación de algoritmos de planificación y optimización complejos.
Objetivo: Generar el código fuente completo (backend y frontend), el esquema de base de datos PostgreSQL y las instrucciones de configuración para una aplicación web que automatice la generación del horario mensual para el servicio de mucamas de un hospital, basándose estrictamente en las reglas y datos proporcionados.
Contexto y Lógica Central (Basado en el Prompt Original):
La aplicación debe implementar la lógica de generación de horarios detallada a continuación. Esta lógica es la especificación central que el motor de planificación de la aplicación debe seguir rigurosamente:
“Objetivo:
Generar el horario de trabajo para el servicio de mucamas del hospital en mayo 2025 (31 días), cumpliendo estrictamente todas las reglas obligatorias según la prioridad definida. Forzar M>T en lunes-viernes no feriados cuando TPT>2 es crítico y no admite excepciones. Calcular totales con precisión.

Información Base
• Periodo: Mayo 2025 .
• Horario a cubrir: 6:00-22:00.
• Turnos:
◦ M (Mañana): 6:00-14:00 (8h).
◦ T (Tarde): 14:00-22:00 (8h).
◦ D (Descanso Semanal).
◦ C (Franco Compensatorio).
◦ F (Libre en Feriado, si no es M/T/LI/LAO/C).
◦ LM (Licencia Médica).
◦ LAO (Licencia Anual Ordinaria).
• Feriados (reglas sábado/domingo): 1 de mayo, 2 de mayo y 25 de mayo.
• Personal:
◦  Rios, Molina, Montu, Cardozo, Garavaglia, Forni, Alamo.
• Continuidad desde ABRIL (últimos 5 días):
Nombre
27 Mar
28 Mar
29 Mar
30 Mar
31 Mar
Días consecutivos al 31 Mar
Rios
D
D
M
M
T
3
Molina
D
D
C
M
M
2
Montu
LAO
LAO
LAO
LAO
M
1
Cardozo
M
M
M
D
D
0
Garavaglia
M
M
T
T
LAO
0
Forni
T
T
D
M
M
2
Alamo
LM
LM
LM
LM
LM
0

Reglas Obligatorias (Priorizadas)
• Prioridad 1: Licencias y Ausencias Críticas
◦ Garavaglia: LAO del 1-18.
◦ Alamo: LM hasta el 25
• Prioridad 2: Cobertura Mínima y Reglas M/T Diarias
◦ Todos los días: Asegurar TPT≥2 (TPT = M + T).
▪ M≥ 1 obligatorio
▪ T≥ 1 obligatorio
▪ Si TPT>2: M>T obligatorio, sin excepciones (M=T está prohibido, T≤M siempre).

• Prioridad 3: Descansos Exactos
◦ Asignar exactamente:
▪ Rios, Cardozo, Molina, Montu, Forni: 9 D.
◦ F no cuenta como D, en Feriado no puede haber D.
• Prioridad 4: 2 Fin de Semana D/D Completo
◦ Garantizar al menos 1 fin de semana D/D completo (sábado D + domingo D) para cada persona elegible (Rios, Molina, Montu, Cardozo, Garavaglia, Forni).
• Prioridad 5: máximo 6 Días Consecutivos
◦ No exceder 6 días de trabajo consecutivos (M o T), considerando continuidad desde mes anterior.

Reglas Flexibles / Preferencias (Aplicar en Orden, Sin Violar Obligatorias)

Intentar 12h de descanso entre T→M.

Alamo: Trabaja de lunes a viernes de M

Preferir bloques D, M y T consecutivos.

Intentar dotación objetivo: 3M/1T (lunes-viernes), 2M/1T (sábados, domingos, feriados).

Buscar balance equitativo M/T (~50/50 si es posible).

Forni: Prefiere trabajar fines de semana y descansar lunes, los jueves de T.

Cardozo: 24 y 25 trabajar de M

Molina: el 1 trabajar de M, 17 y 18D y 19 trabajar de T, 25 de M

Formato de Salida, Cálculos y Verificación
• Entregables:
◦ Código HTML con tabla responsive (.html).
◦ generar Excel (.xlsx).
• Estructura Tabla:
◦ Filas: Personal (Rios, Molina, Montu, Cardozo, Garavaglia, Forni, Alamo).
◦ Columnas: Días (1-31) + Totales por persona (Días trabajados, Mañanas, Tardes, Sábados libres, Domingos libres, F, C, D).
◦ Filas inferiores: Totales por día (TM, TT, TD, TF, TC, TPT).
• Colores:
◦ M: #d4edda (verde claro).
◦ T: #cce5ff (azul claro).
◦ D/C/F: #e9ecef (gris claro).
◦ LM/LAO: #f8d7da (rojo claro).
◦ Totales: #fff3cd (amarillo claro).
• Cálculos Precisos:
◦ Verificar que Días trabajados + C + D + F + LM + LAO = días del mes por persona.
◦ Totales por día: TM (nº M), TT (nº T), TD (nº D), TF (nº F), TC (nº C), TPT (M+T).
• Verificación Rigurosa:
◦ Confirmar cumplimiento estricto de prioridades 1-5, especialmente M>T en lunes-viernes no feriados cuando TPT>2, verificando explícitamente cada día aplicable.
◦ Justificar cualquier incumplimiento inevitable de reglas flexibles (ej. T→M) o reglas de menor prioridad (solo máximo 5 días si es necesario para prioridades 1-4).
◦ Reportar violaciones de M>T, si las hay, con explicación.”

Requisitos Técnicos y Funcionales de la Aplicación:
1. Tecnologías Sugeridas:
◦ Backend: Python (preferiblemente Flask o Django) con una librería ORM (como SQLAlchemy o Django ORM).
◦ Frontend: HTML5, CSS3 (con soporte responsive), JavaScript (puede ser vanilla JS o un framework ligero como Alpine.js o htmx si se requiere interactividad avanzada, pero no es estrictamente necesario para la visualización inicial).
◦ Base de Datos: PostgreSQL.
◦ Generación Excel: Una librería Python como openpyxl o pandas.
2. Estructura de la Base de Datos (PostgreSQL):
◦ Diseña un esquema SQL inicial para almacenar:
▪ Empleados (id, nombre, ¿fecha_contrato?, ¿elegible_finde_completo?, ¿preferencias_especiales_codificadas?).
▪ TiposTurno (codigo, descripcion, hora_inicio, hora_fin, es_trabajo, es_descanso).
▪ Ausencias (id, empleado_id, tipo_ausencia [LAO, LM, C, F], fecha_inicio, fecha_fin).
▪ Feriados (fecha, descripcion).
▪ HorariosGenerados (id, mes, anio, fecha_generacion, ¿estado?).
▪ AsignacionesHorario (horario_generado_id, empleado_id, fecha, tipo_turno_codigo).
▪ HistorialTurnos (empleado_id, fecha, tipo_turno_codigo) - Para almacenar los últimos días del mes anterior necesarios para la regla de días consecutivos.
◦ Proporciona el script CREATE TABLE para estas tablas, incluyendo claves primarias, foráneas y tipos de datos apropiados.
3. Interfaz de Usuario (UI) - Simple:
◦ Una página principal que permita:
▪ Seleccionar el mes y año para generar el horario.
▪ (Opcional/Futuro) Gestionar empleados, ausencias y feriados (para esta versión inicial, se pueden asumir datos fijos o cargados directamente en la BD).
▪ Un botón "Generar Horario".
◦ Una vez generado, mostrar:
▪ La tabla HTML del horario resultante, con los colores especificados en el prompt original y diseño responsive.
▪ Los totales calculados por persona y por día.
▪ Un botón para descargar el horario en formato .xlsx.
▪ Una sección de "Verificación y Alertas" que muestre si todas las reglas obligatorias (Prioridad 1-5) se cumplieron, y liste explícitamente cualquier violación detectada (especialmente la regla M>T cuando TPT>2) o incumplimientos de reglas flexibles justificados.
4. Lógica del Backend (Motor de Planificación):
◦ Implementar un algoritmo (podría ser basado en reglas, backtracking, constraint satisfaction, o incluso una heurística simple si es suficiente) que tome como entrada los datos de la base de datos (empleados, ausencias, feriados, historial mes anterior) para el mes/año seleccionado.
◦ El algoritmo DEBE seguir estrictamente el orden de prioridad de las reglas obligatorias (1 a 5) del prompt original. La regla M>T cuando TPT>2 en días laborables no feriados es CRÍTICA y no admite excepciones.
◦ Aplicar las reglas flexibles/preferencias (1 a 8) solo si no violan las reglas obligatorias.
◦ Calcular con precisión todos los totales requeridos.
◦ Almacenar el horario generado y sus asignaciones en las tablas HorariosGenerados y AsignacionesHorario.
5. Salida y Exportación:
◦ Generar la vista HTML con la tabla coloreada y los totales.
◦ Implementar la función para exportar la misma tabla y totales a un archivo Excel (.xlsx).
6. Instrucciones:
◦ Proporcionar un archivo README.md con instrucciones claras para:
▪ Configurar el entorno de desarrollo (instalación de dependencias - requirements.txt).
▪ Crear y configurar la base de datos PostgreSQL.
▪ Ejecutar las migraciones o scripts SQL para crear las tablas.
▪ (Opcional) Cargar datos iniciales de ejemplo (empleados, ausencias de Mayo 2025 según el prompt original).
▪ Iniciar la aplicación web.
Entregables Esperados:
1. Código Fuente Backend: Archivos Python (app.py o estructura de proyecto Django/Flask), incluyendo el motor de planificación, rutas de la API/vistas, lógica de base de datos (ORM o SQL directo), y la función de exportación a Excel.
2. Código Fuente Frontend: Archivos HTML, CSS y (si es necesario) JavaScript para la interfaz de usuario.
3. Esquema de Base de Datos: Script SQL (schema.sql) con las sentencias CREATE TABLE.
4. Archivo de Dependencias: requirements.txt para Python.
5. Instrucciones: Archivo README.md.
Verificación Clave: Asegúrate de que la implementación del motor de planificación verifique explícitamente y priorice correctamente todas las reglas, especialmente la cobertura mínima (TPT>=2, M>=1, T>=1), la regla M>T crítica, los descansos exactos, el fin de semana D/D y el límite de días consecutivos. La salida de la UI debe reportar sobre el cumplimiento de estas reglas.
  