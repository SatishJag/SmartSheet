import { STATUS_OPTIONS } from '../templates/presets'
import type { AppTemplate, SupportSheet } from './types'

const OPEN_CLOSED = ['Open', 'In review', 'Answered', 'Closed']
const RAG = ['Green', 'Amber', 'Red']

const riskRegister = (rows: SupportSheet['rows']): SupportSheet => ({
  name: 'Risk register',
  columns: [
    { title: 'Risk', type: 'TEXT_NUMBER' },
    { title: 'Category', type: 'PICKLIST', options: ['Schedule', 'Cost', 'Safety', 'Quality', 'Regulatory', 'Supply chain'] },
    { title: 'Likelihood', type: 'PICKLIST', options: ['Low', 'Medium', 'High'] },
    { title: 'Impact', type: 'PICKLIST', options: ['Low', 'Medium', 'High'] },
    { title: 'RAG', type: 'PICKLIST', options: RAG },
    { title: 'Owner', type: 'CONTACT_LIST' },
    { title: 'Mitigation', type: 'TEXT_NUMBER' },
  ],
  rows,
})

const rfiLog: SupportSheet = {
  name: 'RFI log',
  columns: [
    { title: 'RFI #', type: 'TEXT_NUMBER' },
    { title: 'Question', type: 'TEXT_NUMBER' },
    { title: 'Discipline', type: 'TEXT_NUMBER' },
    { title: 'Raised By', type: 'CONTACT_LIST' },
    { title: 'Status', type: 'PICKLIST', options: OPEN_CLOSED },
    { title: 'Due Date', type: 'DATE' },
  ],
  rows: [{ 'RFI #': 'RFI-001', Question: 'Confirm slab edge detail at grid line A', Discipline: 'Structural', Status: 'Open' }],
}

export const CONSTRUCTION: AppTemplate = {
  id: 'construction-management',
  name: 'Construction Management',
  tagline: 'Track each building project in its own plan with a portfolio view.',
  about: [
    'Plan a commercial building project from preconstruction to closeout in a phased schedule with durations and dependencies.',
    'Includes an RFI log, a punch list and a risk register, and sets up the project in Resource Management with a role for each trade lead so you can see who is needed when.',
  ],
  roles: ['Project Manager', 'Superintendent', 'Estimator', 'Architect', 'Site Engineer', 'Safety Officer'],
  disciplines: ['General', 'Civil', 'Concrete', 'Structural steel', 'Envelope', 'Electrical', 'Mechanical', 'Plumbing', 'Finishes'],
  illustration: 'crane',
  plan: [
    {
      name: 'Preconstruction',
      tasks: [
        { name: 'Kick-off and contract award', days: 0, discipline: 'General', role: 'Project Manager' },
        { name: 'Estimate and budget baseline', days: 10, discipline: 'General', role: 'Estimator' },
        { name: 'Design coordination and IFC drawings', days: 15, discipline: 'General', role: 'Architect', parallel: true },
        { name: 'Building permit', days: 20, discipline: 'General', role: 'Project Manager' },
        { name: 'Site logistics and safety plan', days: 5, discipline: 'General', role: 'Safety Officer', parallel: true },
      ],
    },
    {
      name: 'Sitework and foundations',
      tasks: [
        { name: 'Mobilize and site clearing', days: 5, discipline: 'Civil', role: 'Superintendent' },
        { name: 'Excavation and shoring', days: 10, discipline: 'Civil', role: 'Site Engineer' },
        { name: 'Footings and foundation walls', days: 15, discipline: 'Concrete', role: 'Site Engineer' },
        { name: 'Underground utilities', days: 8, discipline: 'Plumbing', role: 'Superintendent', parallel: true },
      ],
    },
    {
      name: 'Structure',
      tasks: [
        { name: 'Structural steel erection', days: 25, discipline: 'Structural steel', role: 'Site Engineer' },
        { name: 'Slabs on deck', days: 15, discipline: 'Concrete', role: 'Superintendent' },
        { name: 'Structure topped out', days: 0, discipline: 'General', role: 'Project Manager' },
      ],
    },
    {
      name: 'Envelope and MEP',
      tasks: [
        { name: 'Curtain wall and cladding', days: 30, discipline: 'Envelope', role: 'Superintendent' },
        { name: 'Roofing', days: 10, discipline: 'Envelope', role: 'Superintendent', parallel: true },
        { name: 'MEP rough-in', days: 30, discipline: 'Mechanical', role: 'Site Engineer', parallel: true },
        { name: 'Building dried in', days: 0, discipline: 'General', role: 'Project Manager' },
      ],
    },
    {
      name: 'Interiors and closeout',
      tasks: [
        { name: 'Framing, drywall and finishes', days: 30, discipline: 'Finishes', role: 'Superintendent' },
        { name: 'MEP trim and testing', days: 10, discipline: 'Electrical', role: 'Site Engineer' },
        { name: 'Punch list', days: 10, discipline: 'General', role: 'Superintendent' },
        { name: 'Certificate of occupancy and handover', days: 0, discipline: 'General', role: 'Project Manager' },
      ],
    },
  ],
  supportSheets: [
    rfiLog,
    {
      name: 'Punch list',
      columns: [
        { title: 'Item', type: 'TEXT_NUMBER' },
        { title: 'Location', type: 'TEXT_NUMBER' },
        { title: 'Assigned To', type: 'CONTACT_LIST' },
        { title: 'Status', type: 'PICKLIST', options: [...STATUS_OPTIONS], role: 'status' },
        { title: 'Due Date', type: 'DATE' },
      ],
      rows: [],
    },
    riskRegister([{ Risk: 'Steel delivery delay', Category: 'Supply chain', Likelihood: 'Medium', Impact: 'High', RAG: 'Amber', Mitigation: 'Early mill order; weekly expediting call' }]),
  ],
}

export const DATA_CENTER: AppTemplate = {
  id: 'data-center',
  name: 'Data Center Build',
  tagline: 'Deliver a data hall from site due diligence to Level 5 commissioning.',
  about: [
    'A phased plan for a new data center or data hall: site and utility due diligence, power and cooling design, long-lead equipment, shell and core, electrical and mechanical installation, IT fit-out and integrated systems testing.',
    'Includes a long-lead equipment log, a commissioning tracker (L1 to L5) and a risk register, and books electrical, mechanical and commissioning roles in Resource Management.',
  ],
  roles: ['Project Manager', 'Electrical Engineer', 'Mechanical Engineer', 'Construction Manager', 'Commissioning Agent', 'IT Infrastructure Lead'],
  disciplines: ['General', 'Civil', 'Electrical', 'Mechanical', 'Controls / BMS', 'Fire protection', 'IT / Network', 'Commissioning'],
  illustration: 'datacenter',
  plan: [
    {
      name: 'Site and due diligence',
      tasks: [
        { name: 'Site selection and feasibility', days: 15, discipline: 'General', role: 'Project Manager' },
        { name: 'Utility power availability study', days: 20, discipline: 'Electrical', role: 'Electrical Engineer', parallel: true },
        { name: 'Fiber route and carrier diversity', days: 10, discipline: 'IT / Network', role: 'IT Infrastructure Lead', parallel: true },
        { name: 'Site acquired', days: 0, discipline: 'General', role: 'Project Manager' },
      ],
    },
    {
      name: 'Design and permitting',
      tasks: [
        { name: 'Power and cooling basis of design', days: 20, discipline: 'Electrical', role: 'Electrical Engineer' },
        { name: 'Mechanical design (chillers, CRAH, containment)', days: 20, discipline: 'Mechanical', role: 'Mechanical Engineer', parallel: true },
        { name: 'Permits and utility interconnect agreement', days: 30, discipline: 'General', role: 'Project Manager' },
      ],
    },
    {
      name: 'Long-lead procurement',
      tasks: [
        { name: 'Order generators', days: 5, discipline: 'Electrical', role: 'Electrical Engineer' },
        { name: 'Order UPS and switchgear', days: 5, discipline: 'Electrical', role: 'Electrical Engineer', parallel: true },
        { name: 'Order chillers', days: 5, discipline: 'Mechanical', role: 'Mechanical Engineer', parallel: true },
      ],
    },
    {
      name: 'Shell and core',
      tasks: [
        { name: 'Site works and foundations', days: 25, discipline: 'Civil', role: 'Construction Manager' },
        { name: 'Steel frame and roof', days: 30, discipline: 'Civil', role: 'Construction Manager' },
        { name: 'Raised floor and containment', days: 15, discipline: 'Mechanical', role: 'Construction Manager' },
      ],
    },
    {
      name: 'Electrical and mechanical installation',
      tasks: [
        { name: 'Substation and MV switchgear', days: 30, discipline: 'Electrical', role: 'Electrical Engineer' },
        { name: 'Generators and fuel system', days: 20, discipline: 'Electrical', role: 'Electrical Engineer', parallel: true },
        { name: 'UPS, batteries and PDUs', days: 25, discipline: 'Electrical', role: 'Electrical Engineer' },
        { name: 'Chilled water plant and CRAH units', days: 35, discipline: 'Mechanical', role: 'Mechanical Engineer', parallel: true },
        { name: 'BMS / EPMS controls', days: 15, discipline: 'Controls / BMS', role: 'Mechanical Engineer' },
        { name: 'Fire detection and suppression', days: 15, discipline: 'Fire protection', role: 'Construction Manager', parallel: true },
      ],
    },
    {
      name: 'IT fit-out',
      tasks: [
        { name: 'Racks, cable tray and structured cabling', days: 20, discipline: 'IT / Network', role: 'IT Infrastructure Lead' },
        { name: 'Meet-me room and carrier cross-connects', days: 10, discipline: 'IT / Network', role: 'IT Infrastructure Lead' },
      ],
    },
    {
      name: 'Commissioning and handover',
      tasks: [
        { name: 'L1-L2 factory and installation checks', days: 10, discipline: 'Commissioning', role: 'Commissioning Agent' },
        { name: 'L3 start-up and functional tests', days: 10, discipline: 'Commissioning', role: 'Commissioning Agent' },
        { name: 'L4 system performance tests', days: 10, discipline: 'Commissioning', role: 'Commissioning Agent' },
        { name: 'L5 integrated systems test (load banks)', days: 5, discipline: 'Commissioning', role: 'Commissioning Agent' },
        { name: 'Ready for service', days: 0, discipline: 'General', role: 'Project Manager' },
      ],
    },
  ],
  supportSheets: [
    {
      name: 'Long-lead equipment',
      columns: [
        { title: 'Equipment', type: 'TEXT_NUMBER' },
        { title: 'Vendor', type: 'TEXT_NUMBER' },
        { title: 'Quantity', type: 'TEXT_NUMBER' },
        { title: 'Lead Time (weeks)', type: 'TEXT_NUMBER' },
        { title: 'PO Date', type: 'DATE' },
        { title: 'Required On Site', type: 'DATE' },
        { title: 'Status', type: 'PICKLIST', options: ['Not ordered', 'Ordered', 'In fabrication', 'Shipped', 'Delivered'] },
      ],
      rows: [
        { Equipment: 'Diesel generator 3 MW', Quantity: 4, 'Lead Time (weeks)': 52, Status: 'Not ordered' },
        { Equipment: 'UPS module 1.2 MW', Quantity: 6, 'Lead Time (weeks)': 36, Status: 'Not ordered' },
        { Equipment: 'MV switchgear lineup', Quantity: 2, 'Lead Time (weeks)': 44, Status: 'Not ordered' },
        { Equipment: 'Air-cooled chiller 1,500 kW', Quantity: 5, 'Lead Time (weeks)': 30, Status: 'Not ordered' },
      ],
    },
    {
      name: 'Commissioning tracker',
      columns: [
        { title: 'System', type: 'TEXT_NUMBER' },
        { title: 'Level', type: 'PICKLIST', options: ['L1', 'L2', 'L3', 'L4', 'L5'] },
        { title: 'Test Script', type: 'TEXT_NUMBER' },
        { title: 'Witness', type: 'CONTACT_LIST' },
        { title: 'Result', type: 'PICKLIST', options: ['Not started', 'Pass', 'Fail', 'Retest'] },
        { title: 'Date', type: 'DATE' },
      ],
      rows: [
        { System: 'Generator 1', Level: 'L3', 'Test Script': 'GEN-L3-01', Result: 'Not started' },
        { System: 'UPS A', Level: 'L3', 'Test Script': 'UPS-L3-01', Result: 'Not started' },
        { System: 'Chilled water plant', Level: 'L4', 'Test Script': 'CHW-L4-01', Result: 'Not started' },
        { System: 'Data hall 1', Level: 'L5', 'Test Script': 'IST-01', Result: 'Not started' },
      ],
    },
    riskRegister([
      { Risk: 'Utility interconnect delayed', Category: 'Regulatory', Likelihood: 'Medium', Impact: 'High', RAG: 'Red', Mitigation: 'Temporary generation; weekly utility meetings' },
      { Risk: 'Generator lead time slips', Category: 'Supply chain', Likelihood: 'High', Impact: 'High', RAG: 'Amber', Mitigation: 'Reserve slots with two vendors' },
    ]),
  ],
}

export const REAL_ESTATE: AppTemplate = {
  id: 'real-estate',
  name: 'Real Estate Development',
  tagline: 'Take a development from acquisition to stabilized asset.',
  about: [
    'A development plan covering acquisition and due diligence, entitlements, financing, design, construction, leasing and stabilization.',
    'Includes a due-diligence checklist, a leasing tracker and a risk register, and books development, legal, design and leasing roles in Resource Management.',
  ],
  roles: ['Development Manager', 'Financial Analyst', 'Legal Counsel', 'Architect', 'Construction Manager', 'Leasing Agent'],
  disciplines: ['Acquisition', 'Legal', 'Finance', 'Planning', 'Design', 'Construction', 'Leasing', 'Asset management'],
  illustration: 'buildings',
  plan: [
    {
      name: 'Acquisition and due diligence',
      tasks: [
        { name: 'Letter of intent signed', days: 0, discipline: 'Acquisition', role: 'Development Manager' },
        { name: 'Title, survey and environmental (Phase I)', days: 20, discipline: 'Legal', role: 'Legal Counsel' },
        { name: 'Market study and pro forma', days: 15, discipline: 'Finance', role: 'Financial Analyst', parallel: true },
        { name: 'Purchase and sale agreement', days: 10, discipline: 'Legal', role: 'Legal Counsel' },
        { name: 'Closing', days: 0, discipline: 'Acquisition', role: 'Development Manager' },
      ],
    },
    {
      name: 'Entitlements',
      tasks: [
        { name: 'Zoning analysis and pre-application', days: 15, discipline: 'Planning', role: 'Development Manager' },
        { name: 'Site plan approval', days: 40, discipline: 'Planning', role: 'Legal Counsel' },
        { name: 'Community engagement', days: 20, discipline: 'Planning', role: 'Development Manager', parallel: true },
      ],
    },
    {
      name: 'Financing',
      tasks: [
        { name: 'Equity raise', days: 30, discipline: 'Finance', role: 'Financial Analyst' },
        { name: 'Construction loan closing', days: 20, discipline: 'Finance', role: 'Financial Analyst' },
      ],
    },
    {
      name: 'Design and preconstruction',
      tasks: [
        { name: 'Schematic design', days: 20, discipline: 'Design', role: 'Architect' },
        { name: 'Design development', days: 25, discipline: 'Design', role: 'Architect' },
        { name: 'Construction documents and GC bidding', days: 30, discipline: 'Design', role: 'Construction Manager' },
      ],
    },
    {
      name: 'Construction',
      tasks: [
        { name: 'Groundbreaking', days: 0, discipline: 'Construction', role: 'Development Manager' },
        { name: 'Vertical construction', days: 120, discipline: 'Construction', role: 'Construction Manager' },
        { name: 'Certificate of occupancy', days: 0, discipline: 'Construction', role: 'Construction Manager' },
      ],
    },
    {
      name: 'Leasing and stabilization',
      tasks: [
        { name: 'Marketing launch and pre-leasing', days: 60, discipline: 'Leasing', role: 'Leasing Agent' },
        { name: 'Tenant improvements and move-ins', days: 40, discipline: 'Leasing', role: 'Leasing Agent' },
        { name: 'Stabilization (90% occupancy)', days: 0, discipline: 'Asset management', role: 'Development Manager' },
        { name: 'Refinance or disposition', days: 30, discipline: 'Finance', role: 'Financial Analyst' },
      ],
    },
  ],
  supportSheets: [
    {
      name: 'Due diligence checklist',
      columns: [
        { title: 'Item', type: 'TEXT_NUMBER' },
        { title: 'Category', type: 'PICKLIST', options: ['Legal', 'Physical', 'Environmental', 'Financial', 'Zoning'] },
        { title: 'Responsible', type: 'CONTACT_LIST' },
        { title: 'Received', type: 'CHECKBOX' },
        { title: 'Due Date', type: 'DATE' },
        { title: 'Notes', type: 'TEXT_NUMBER' },
      ],
      rows: [
        { Item: 'Title commitment', Category: 'Legal', Received: false },
        { Item: 'ALTA survey', Category: 'Physical', Received: false },
        { Item: 'Phase I environmental report', Category: 'Environmental', Received: false },
        { Item: 'Rent roll and operating statements', Category: 'Financial', Received: false },
        { Item: 'Zoning report', Category: 'Zoning', Received: false },
      ],
    },
    {
      name: 'Leasing tracker',
      columns: [
        { title: 'Unit', type: 'TEXT_NUMBER' },
        { title: 'Area (sq ft)', type: 'TEXT_NUMBER' },
        { title: 'Prospect / Tenant', type: 'TEXT_NUMBER' },
        { title: 'Stage', type: 'PICKLIST', options: ['Available', 'Tour', 'Proposal', 'LOI', 'Lease out', 'Signed'] },
        { title: 'Rent ($/sq ft/yr)', type: 'TEXT_NUMBER' },
        { title: 'Lease Start', type: 'DATE' },
      ],
      rows: [
        { Unit: '101', 'Area (sq ft)': 2400, Stage: 'Available' },
        { Unit: '102', 'Area (sq ft)': 1800, Stage: 'Available' },
        { Unit: '201', 'Area (sq ft)': 5200, Stage: 'Available' },
      ],
    },
    riskRegister([{ Risk: 'Entitlement appeal', Category: 'Regulatory', Likelihood: 'Low', Impact: 'High', RAG: 'Amber', Mitigation: 'Early community engagement' }]),
  ],
}

export const TENANT_FIT_OUT: AppTemplate = {
  id: 'tenant-fit-out',
  name: 'Tenant Fit-Out',
  tagline: 'Interior fit-out of office or retail space, survey to handover.',
  about: [
    'A compact plan for interior fit-out and tenant improvement work: survey, design, approvals, strip-out, MEP, finishes, furniture and handover.',
    'Includes an RFI log and a punch list, and books design and site roles in Resource Management.',
  ],
  roles: ['Project Manager', 'Interior Designer', 'Site Supervisor', 'MEP Coordinator'],
  disciplines: ['General', 'Design', 'Demolition', 'Electrical', 'Mechanical', 'Finishes', 'Furniture'],
  illustration: 'fitout',
  plan: [
    {
      name: 'Design and approvals',
      tasks: [
        { name: 'Measured survey', days: 3, discipline: 'Design', role: 'Interior Designer' },
        { name: 'Space plan and design', days: 15, discipline: 'Design', role: 'Interior Designer' },
        { name: 'Landlord and building approvals', days: 10, discipline: 'General', role: 'Project Manager' },
      ],
    },
    {
      name: 'Construction',
      tasks: [
        { name: 'Strip-out', days: 5, discipline: 'Demolition', role: 'Site Supervisor' },
        { name: 'MEP first fix', days: 10, discipline: 'Mechanical', role: 'MEP Coordinator' },
        { name: 'Partitions and ceilings', days: 10, discipline: 'Finishes', role: 'Site Supervisor', parallel: true },
        { name: 'Finishes and second fix', days: 10, discipline: 'Finishes', role: 'Site Supervisor' },
      ],
    },
    {
      name: 'Handover',
      tasks: [
        { name: 'Furniture and IT install', days: 5, discipline: 'Furniture', role: 'Project Manager' },
        { name: 'Snagging', days: 5, discipline: 'General', role: 'Site Supervisor' },
        { name: 'Handover to tenant', days: 0, discipline: 'General', role: 'Project Manager' },
      ],
    },
  ],
  supportSheets: [
    rfiLog,
    {
      name: 'Punch list',
      columns: [
        { title: 'Item', type: 'TEXT_NUMBER' },
        { title: 'Location', type: 'TEXT_NUMBER' },
        { title: 'Assigned To', type: 'CONTACT_LIST' },
        { title: 'Status', type: 'PICKLIST', options: [...STATUS_OPTIONS], role: 'status' },
      ],
      rows: [],
    },
  ],
}

/** In gallery order. */
export const APP_TEMPLATES: AppTemplate[] = [CONSTRUCTION, DATA_CENTER, REAL_ESTATE, TENANT_FIT_OUT]
