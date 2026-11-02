(function () {
  'use strict';

  const emptyData = () => ({ households: [], applications: [], readings: [], invoices: [], payments: [], tariff: 0, chairpersonName: '' });
  const today = localDateString(new Date());
  const HISTORY_PAGE_SIZE = 10;
  const RECEIPT_BUCKET = 'payment-receipts';
  const MAX_RECEIPT_IMAGE_SIZE = 5 * 1024 * 1024;
  const RECEIPT_IMAGE_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  };
  let data = emptyData();
  const historyPages = { billing: 0, payments: 0 };
  const customerDetailPages = { invoices: 0, payments: 0 };
  let pendingBulkReadings = [];
  let pendingBulkContext = '';
  let activeCustomerDetailsId = '';
  let storageReady = false;
  let supabaseClient;
  let toastTimer;
  let modalToastTimer;

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  async function loadData() {
    const [households, applications, readings, invoices, payments, settings] = await Promise.all([
      supabaseClient.from('households').select('id, created_at, surname, first_name, initials, date_of_birth, phone, id_number, site_address, plot_number, property_type, alternate_contact_name, alternate_contact_phone, area, house_number, street, supply_plot'),
      supabaseClient.from('applications').select('record'),
      supabaseClient.from('readings').select('record'),
      supabaseClient.from('invoices').select('record'),
      supabaseClient.from('payments').select('record'),
      supabaseClient.from('workspace_settings').select('tariff, chairperson_name').eq('id', 1).maybeSingle()
    ]);
    for (const result of [households, applications, readings, invoices, payments, settings]) {
      if (result.error) throw result.error;
    }
    data = {
      households: households.data.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        surname: row.surname,
        firstName: row.first_name,
        initials: row.initials,
        dob: row.date_of_birth,
        phone: row.phone,
        idNumber: row.id_number,
        siteAddress: row.site_address,
        plotNumber: row.plot_number,
        propertyType: row.property_type,
        altName: row.alternate_contact_name,
        altPhone: row.alternate_contact_phone,
        area: row.area,
        houseNumber: row.house_number,
        street: row.street,
        supplyPlot: row.supply_plot
      })),
      applications: applications.data.map((row) => row.record),
      readings: readings.data.map((row) => row.record),
      invoices: invoices.data.map((row) => row.record),
      payments: payments.data.map((row) => row.record),
      tariff: settings.data ? Number(settings.data.tariff) : 0,
      chairpersonName: settings.data ? settings.data.chairperson_name || '' : ''
    };
  }

  async function saveChangedRecords(table, previousRecords, nextRecords, toRow) {
    const previousById = new Map(previousRecords.map((record) => [record.id, record]));
    const changed = nextRecords
      .filter((record) => JSON.stringify(previousById.get(record.id)) !== JSON.stringify(record))
      .map(toRow);
    if (!changed.length) return;
    const { error } = await supabaseClient.from(table).upsert(changed, { onConflict: 'id' });
    if (error) throw error;
  }

  async function persistChanges(previousData, nextData) {
    await saveChangedRecords('households', previousData.households, nextData.households, (record) => ({
      id: record.id,
      created_at: record.createdAt,
      surname: record.surname,
      first_name: record.firstName,
      initials: record.initials,
      date_of_birth: record.dob,
      phone: record.phone,
      id_number: record.idNumber,
      site_address: record.siteAddress,
      plot_number: record.plotNumber,
      property_type: record.propertyType,
      alternate_contact_name: record.altName,
      alternate_contact_phone: record.altPhone,
      area: record.area,
      house_number: record.houseNumber,
      street: record.street,
      supply_plot: record.supplyPlot,
      record
    }));
    await saveChangedRecords('applications', previousData.applications, nextData.applications, (record) => ({
      id: record.id,
      household_id: record.householdId,
      application_number: record.applicationNumber,
      status: record.status,
      created_at: record.createdAt,
      record
    }));
    await saveChangedRecords('readings', previousData.readings, nextData.readings, (record) => ({
      id: record.id,
      application_id: record.customerId,
      date: record.date,
      created_at: record.createdAt,
      record
    }));
    await saveChangedRecords('payments', previousData.payments, nextData.payments, (record) => ({
      id: record.id,
      application_id: record.customerId,
      invoice_id: record.invoiceId || null,
      date: record.date,
      created_at: record.createdAt,
      record
    }));
    if (previousData.tariff !== nextData.tariff || previousData.chairpersonName !== nextData.chairpersonName) {
      const { error } = await supabaseClient.from('workspace_settings').upsert(
        { id: 1, tariff: nextData.tariff, chairperson_name: nextData.chairpersonName },
        { onConflict: 'id' }
      );
      if (error) throw error;
    }
  }

  async function commit(nextData, successMessage) {
    if (!storageReady) {
      showToast('Changes were not saved because the workspace is not available.', true);
      return false;
    }
    try {
      await persistChanges(data, nextData);
      data = nextData;
      renderAll();
      if (successMessage) showToast(successMessage);
      return true;
    } catch (error) {
      console.error('Unable to save Besse Water workspace data to Supabase.', error);
      if (error && error.code === '23505' && String(error.message).includes('readings_one_per_meter_month_idx')) {
        showToast('A meter reading has already been recorded for this meter in that month.', true);
        return false;
      }
      showToast('Could not save changes to the shared workspace. Check the connection and try again.', true);
      return false;
    }
  }

  function showToast(message, isError) {
    const activeDialog = document.querySelector('dialog[open]');
    if (activeDialog) {
      const container = activeDialog.querySelector('.application-form, .review-card');
      const header = container && container.querySelector('.dialog-header');
      if (container && header) {
        byId('toast').classList.remove('show');
        window.clearTimeout(toastTimer);
        let notification = container.querySelector('.modal-notification');
        if (!notification) {
          notification = document.createElement('div');
          notification.className = 'modal-notification';
          header.insertAdjacentElement('afterend', notification);
        }
        notification.textContent = message;
        notification.classList.toggle('error', Boolean(isError));
        notification.classList.add('show');
        notification.setAttribute('role', isError ? 'alert' : 'status');
        notification.setAttribute('aria-live', isError ? 'assertive' : 'polite');
        window.clearTimeout(modalToastTimer);
        modalToastTimer = window.setTimeout(() => notification.classList.remove('show'), 4200);
        return;
      }
    }
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.toggle('error', Boolean(isError));
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4200);
  }

  function money(amount) {
    const safeAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
    return `GMD ${safeAmount.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function displayDate(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  }

  function householdFor(application) {
    return data.households.find((household) => household.id === application.householdId);
  }

  function nameOf(application) {
    const household = householdFor(application);
    return household ? [household.firstName, household.initials, household.surname].filter(Boolean).join(' ') : 'Unknown household';
  }

  function addressOf(application) {
    const household = householdFor(application);
    return household ? household.siteAddress : '';
  }

  function customerLabel(application) {
    return `${nameOf(application)} · ${application.meterNumber || application.applicationNumber}`;
  }

  function approvedCustomers() {
    return data.applications.filter((application) => application.status === 'Approved');
  }

  function readingsFor(customerId) {
    return data.readings
      .filter((reading) => reading.customerId === customerId)
      .sort((first, second) => first.date.localeCompare(second.date) || first.createdAt.localeCompare(second.createdAt));
  }

  function lastReadingFor(application) {
    const readings = readingsFor(application.id);
    const latest = readings[readings.length - 1];
    return latest ? Number(latest.reading) : Number(application.initialReading || 0);
  }

  function customerBalance(customerId) {
    const application = data.applications.find((entry) => entry.id === customerId);
    if (!application || application.status !== 'Approved') return 0;
    const connectionFee = Number(application.connectionFee || 0);
    const feePaid = application.connectionReceipt && connectionFee > 0 ? connectionFee : 0;
    const usageCharges = data.readings
      .filter((reading) => reading.customerId === customerId)
      .reduce((total, reading) => total + Number(reading.charge || 0), 0);
    const payments = data.payments
      .filter((payment) => payment.customerId === customerId)
      .reduce((total, payment) => total + Number(payment.amount || 0), 0);
    return connectionFee - feePaid + usageCharges - payments;
  }

  function invoiceNumberFor(readingId, date) {
    return `INV-${date.slice(0, 7).replace('-', '')}-${readingId.replace(/-/g, '').toUpperCase()}`;
  }

  function bulkReadingContext() {
    return JSON.stringify({
      tariff: data.tariff,
      applications: data.applications.map((application) => [
        application.id, application.status, application.applicationNumber, application.initialReading,
        application.meterNumber, nameOf(application)
      ]),
      readings: data.readings.map((reading) => [
        reading.id, reading.customerId, reading.date, reading.reading
      ])
    });
  }

  function downloadReadingTemplate() {
    if (!window.XLSX) {
      showToast('Excel support is unavailable. Reload the page and try again.', true);
      return;
    }
    const headers = [
      'Application ID',
      'Application Number',
      'Household',
      'Meter Number',
      'Current Meter Reading'
    ];
    const rows = approvedCustomers().map((application) => [
      application.id,
      application.applicationNumber,
      nameOf(application),
      application.meterNumber || '',
      ''
    ]);
    const worksheet = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
    worksheet['!cols'] = [
      { wch: 38 },
      { wch: 22 },
      { wch: 28 },
      { wch: 20 },
      { wch: 25 }
    ];
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, 'Meter Readings');
    window.XLSX.writeFile(workbook, `Besse-Water-Meter-Readings-${today}.xlsx`);
  }

  async function previewBulkReadings(file) {
    pendingBulkReadings = [];
    pendingBulkContext = '';
    byId('import-bulk-readings').disabled = true;
    const preview = byId('bulk-reading-preview');
    if (!file) {
      preview.textContent = '';
      return;
    }
    if (!window.XLSX) {
      preview.textContent = 'Excel support is unavailable. Reload the page and try again.';
      return;
    }
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      preview.textContent = 'Choose an Excel workbook (.xlsx or .xls).';
      return;
    }
    const uploadDate = localDateString(new Date());
    try {
      const workbook = window.XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) throw new Error('The workbook contains no worksheet.');
      const rows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: true });
      const expectedHeaders = [
        'application id',
        'application number',
        'household',
        'meter number',
        'current meter reading'
      ];
      const headers = (rows[0] || []).map((value) => String(value).trim().toLowerCase());
      const columnIndexes = expectedHeaders.map((header) => headers.indexOf(header));
      if (columnIndexes.some((index) => index < 0)) {
        preview.textContent = 'The worksheet columns do not match the Besse Water meter-reading template. Download a fresh template and keep its column headers unchanged.';
        return;
      }

      const issues = [];
      const candidates = [];
      rows.slice(1).forEach((row, index) => {
        const lineNumber = index + 2;
        const values = columnIndexes.map((columnIndex) => row[columnIndex]);
        if (values.every((value) => String(value == null ? '' : value).trim() === '')) return;
        const applicationId = String(values[0] == null ? '' : values[0]).trim();
        const applicationNumber = String(values[1] == null ? '' : values[1]).trim();
        const application = data.applications.find((entry) => entry.id === applicationId);
        const date = uploadDate;
        const readingValue = Number(values[4]);
        const householdName = String(values[2] == null ? '' : values[2]).trim();
        const meterNumber = String(values[3] == null ? '' : values[3]).trim();
        if (!application || application.applicationNumber !== applicationNumber || application.status !== 'Approved'
          || nameOf(application) !== householdName || (application.meterNumber || '') !== meterNumber) {
          issues.push(`Row ${lineNumber}: account identifiers do not match an approved meter account. Restore the template's application, household, and meter details.`);
          return;
        }
        if (String(values[4] == null ? '' : values[4]).trim() === '' || !Number.isFinite(readingValue) || readingValue < 0) {
          issues.push(`Row ${lineNumber}: enter a valid non-negative current meter reading.`);
          return;
        }
        candidates.push({ application, applicationId, date, readingValue, lineNumber });
      });

      const seenMonths = new Set();
      const orderedCandidates = candidates.sort((first, second) =>
        first.applicationId.localeCompare(second.applicationId) || first.date.localeCompare(second.date));
      const latestByApplication = new Map();
      for (const candidate of orderedCandidates) {
        const monthKey = `${candidate.applicationId}:${candidate.date.slice(0, 7)}`;
        if (seenMonths.has(monthKey) || readingsFor(candidate.applicationId).some((reading) => reading.date.slice(0, 7) === candidate.date.slice(0, 7))) {
          issues.push(`Row ${candidate.lineNumber}: this meter already has a reading for ${candidate.date.slice(0, 7)}, or the workbook contains another reading for that meter and month.`);
          continue;
        }
        seenMonths.add(monthKey);
        const previous = latestByApplication.get(candidate.applicationId) || (() => {
          const readings = readingsFor(candidate.applicationId);
          const latestReading = readings[readings.length - 1];
          return {
            date: latestReading ? latestReading.date : '',
            value: latestReading ? Number(latestReading.reading) : Number(candidate.application.initialReading || 0)
          };
        })();
        if (previous.date && candidate.date < previous.date) {
          issues.push(`Row ${candidate.lineNumber}: reading date cannot be earlier than the latest recorded reading (${displayDate(previous.date)}).`);
          continue;
        }
        if (candidate.readingValue < previous.value) {
          issues.push(`Row ${candidate.lineNumber}: reading cannot be lower than the previous reading (${previous.value}).`);
          continue;
        }
        const consumption = candidate.readingValue - previous.value;
        const createdAt = new Date().toISOString();
        const reading = {
          id: crypto.randomUUID(),
          customerId: candidate.applicationId,
          date: candidate.date,
          reading: candidate.readingValue,
          previousReading: previous.value,
          consumption,
          tariff: data.tariff,
          charge: Math.round(consumption * data.tariff * 100) / 100,
          createdAt
        };
        const invoice = {
          id: reading.id,
          readingId: reading.id,
          invoiceNumber: invoiceNumberFor(reading.id, reading.date),
          customerId: reading.customerId,
          date: reading.date,
          amount: reading.charge,
          createdAt
        };
        pendingBulkReadings.push({ reading, invoice });
        latestByApplication.set(candidate.applicationId, { date: candidate.date, value: candidate.readingValue });
      }

      if (issues.length) {
        pendingBulkReadings = [];
        preview.innerHTML = `<strong>Import blocked: ${issues.length} issue(s) found.</strong><ul>${issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>Correct the workbook and upload it again. No readings or invoices have been saved.`;
        return;
      }
      if (!pendingBulkReadings.length) {
        preview.textContent = 'No meter readings were found. Fill at least one row and upload the workbook again.';
        return;
      }
      pendingBulkContext = bulkReadingContext();
      byId('import-bulk-readings').disabled = false;
      preview.textContent = `${pendingBulkReadings.length} reading(s) passed validation. Import will save the readings and generate their invoices.`;
    } catch (error) {
      pendingBulkReadings = [];
      pendingBulkContext = '';
      console.error('Unable to read the bulk meter-reading workbook.', error);
      preview.textContent = 'Could not read this Excel workbook. Check that the file is a valid, unprotected .xlsx or .xls workbook.';
    }
  }

  async function importBulkReadings() {
    if (!pendingBulkReadings.length) return;
    if (pendingBulkContext !== bulkReadingContext()) {
      pendingBulkReadings = [];
      pendingBulkContext = '';
      byId('import-bulk-readings').disabled = true;
      byId('bulk-reading-preview').textContent = 'Meter readings or the tariff changed after validation. Upload the workbook again to validate it against the latest records.';
      return;
    }
    const imported = [...pendingBulkReadings];
    const nextData = {
      ...data,
      readings: [...data.readings, ...imported.map((entry) => entry.reading)],
      invoices: [...data.invoices, ...imported.map((entry) => entry.invoice)]
    };
    if (await commit(nextData, `${imported.length} meter reading(s) imported and ${imported.length} invoice(s) generated.`)) {
      pendingBulkReadings = [];
      pendingBulkContext = '';
      byId('bulk-reading-file').value = '';
      byId('import-bulk-readings').disabled = true;
      byId('bulk-reading-preview').textContent = `${imported.length} reading(s) saved and ${imported.length} invoice(s) generated successfully.`;
    }
  }

  function invoiceBalance(invoiceId) {
    const invoice = data.invoices.find((entry) => entry.id === invoiceId);
    if (!invoice) return 0;
    const paidCents = data.payments
      .filter((payment) => payment.invoiceId === invoiceId)
      .reduce((total, payment) => total + Math.round(Number(payment.amount || 0) * 100), 0);
    return (Math.round(Number(invoice.amount) * 100) - paidCents) / 100;
  }

  function billingEvents() {
    const charges = [];
    data.applications.filter((application) => application.status === 'Approved' && Number(application.connectionFee) > 0)
      .forEach((application) => {
        charges.push({
          date: application.approvedDate || application.createdAt.slice(0, 10),
          customerId: application.id,
          type: 'Connection fee',
          detail: 'Connection fee payable',
          amount: Number(application.connectionFee),
          kind: 'charge',
          id: `${application.id}-fee`
        });
      });
    return charges.concat(data.readings.map((reading) => {
      const invoice = data.invoices.find((entry) => entry.readingId === reading.id || entry.id === reading.id);
      return {
        ...reading,
        type: 'Water usage',
        detail: `${Number(reading.consumption).toLocaleString('en')} units`,
        invoiceNumber: invoice ? invoice.invoiceNumber : '',
        amount: Number(reading.charge),
        kind: 'charge'
      };
    })).sort((first, second) => second.date.localeCompare(first.date) || String(second.id).localeCompare(String(first.id)));
  }

  function paymentEvents() {
    const events = [];
    data.applications.filter((application) => application.status === 'Approved' && Number(application.connectionFee) > 0 && application.connectionReceipt)
      .forEach((application) => events.push({
        date: application.approvedDate || application.createdAt.slice(0, 10),
        customerId: application.id,
        type: 'Connection fee payment',
        detail: `Receipt ${application.connectionReceipt}`,
        amount: Number(application.connectionFee),
        kind: 'payment',
        id: `${application.id}-fee-payment`
      }));
    data.payments.forEach((payment) => {
      const invoice = data.invoices.find((entry) => entry.id === payment.invoiceId);
      events.push({
        ...payment,
        type: 'Payment',
        detail: payment.receipt ? `Receipt ${payment.receipt}` : 'Payment received',
        invoiceNumber: invoice ? invoice.invoiceNumber : '',
        receiptImagePath: payment.receiptImagePath || '',
        amount: Number(payment.amount),
        kind: 'payment'
      });
    });
    return events.sort((first, second) => second.date.localeCompare(first.date) || String(second.id).localeCompare(String(first.id)));
  }

  function allBillingEvents() {
    return billingEvents().concat(paymentEvents())
      .sort((first, second) => second.date.localeCompare(first.date) || String(second.id).localeCompare(String(first.id)));
  }

  function renderDashboard() {
    const customers = approvedCustomers();
    const month = today.slice(0, 7);
    const balance = customers.reduce((total, customer) => total + customerBalance(customer.id), 0);
    byId('stat-customers').textContent = String(customers.length);
    byId('stat-pending').textContent = String(data.applications.filter((application) => application.status === 'Pending').length);
    byId('stat-readings').textContent = String(data.readings.filter((reading) => reading.date.startsWith(month)).length);
    byId('stat-balance').textContent = money(balance);

    const recent = [...data.applications].sort((first, second) => second.createdAt.localeCompare(first.createdAt)).slice(0, 5);
    byId('recent-applications').innerHTML = recent.map((application) => `
      <tr><td><strong>${escapeHtml(nameOf(application))}</strong></td>
      <td>${escapeHtml(application.applicationNumber)}</td>
      <td>${escapeHtml(addressOf(application))}</td>
      <td><span class="status status-${application.status.toLowerCase()}">${escapeHtml(application.status)}</span></td></tr>`).join('');
    byId('empty-applications').classList.toggle('visible', recent.length === 0);

    const events = allBillingEvents().slice(0, 5);
    byId('recent-activity').innerHTML = events.map((event) => {
      const customer = data.applications.find((application) => application.id === event.customerId);
      const isPayment = event.kind === 'payment';
      return `<div class="activity-item"><span class="activity-icon${isPayment ? ' payment' : ''}" aria-hidden="true">${isPayment ? '₵' : '◉'}</span>
        <div class="activity-copy"><strong>${escapeHtml(event.type)} · ${escapeHtml(customer ? customerLabel(customer) : 'Customer')}</strong><small>${escapeHtml(displayDate(event.date))} · ${escapeHtml(event.detail)}</small></div>
        <span class="activity-amount">${isPayment ? '−' : ''}${money(event.amount)}</span></div>`;
    }).join('');
    byId('empty-activity').classList.toggle('visible', events.length === 0);
  }

  function renderApplications() {
    const query = byId('application-search').value.trim().toLowerCase();
    const applications = [...data.applications]
      .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
      .filter((application) => `${nameOf(application)} ${application.applicationNumber} ${addressOf(application)}`.toLowerCase().includes(query));
    byId('application-count').textContent = `${data.applications.length} ${data.applications.length === 1 ? 'record' : 'records'}`;
    byId('applications-table').innerHTML = applications.map((application) => {
      const actionClass = application.status === 'Approved' ? 'row-action row-action-approved' : 'row-action';
      const action = `<button class="${actionClass}" type="button" data-review="${escapeHtml(application.id)}">Review</button>`;
      return `<tr><td><strong>${escapeHtml(nameOf(application))}</strong></td>
        <td>${escapeHtml(application.applicationNumber)}</td><td>${escapeHtml(displayDate(application.createdAt.slice(0, 10)))}</td>
        <td>${escapeHtml(application.connectionType)}</td><td>${escapeHtml(addressOf(application))}</td>
        <td><span class="status status-${application.status.toLowerCase()}">${escapeHtml(application.status)}</span></td><td>${action}</td></tr>`;
    }).join('');
    byId('applications-empty').classList.toggle('visible', applications.length === 0);
  }

  function renderCustomers() {
    const query = byId('customer-search').value.trim().toLowerCase();
    const customers = approvedCustomers().filter((customer) => {
      const household = householdFor(customer);
      return `${nameOf(customer)} ${customer.applicationNumber} ${household ? household.phone : ''} ${household ? household.area : ''} ${household ? household.houseNumber : ''} ${customer.meterNumber}`.toLowerCase().includes(query);
    });
    byId('customer-count').textContent = `${approvedCustomers().length} approved meter ${approvedCustomers().length === 1 ? 'connection' : 'connections'}`;
    byId('customers-table').innerHTML = customers.map((customer) => {
      const household = householdFor(customer);
      return `
      <tr><td><button class="row-action customer-name-action" type="button" data-customer-details="${escapeHtml(customer.id)}" aria-label="View invoices and payments for ${escapeHtml(nameOf(customer))}"><strong>${escapeHtml(nameOf(customer))}</strong></button></td><td>${escapeHtml(customer.applicationNumber)}</td>
      <td>${escapeHtml(household ? household.phone : '')}</td><td>${escapeHtml(household ? [household.area, household.houseNumber].filter(Boolean).join(' · ') || household.siteAddress : '')}</td>
      <td>${escapeHtml(customer.meterNumber || '—')}</td><td><strong>${money(customerBalance(customer.id))}</strong></td></tr>`;
    }).join('');
    byId('customers-empty').classList.toggle('visible', customers.length === 0);

    const options = approvedCustomers().map((customer) =>
      `<option value="${escapeHtml(customer.id)}">${escapeHtml(customerLabel(customer))}</option>`).join('');
    document.querySelectorAll('#reading-form .customer-select').forEach((select) => {
      const selected = select.value;
      select.innerHTML = `<option value="">Choose a customer</option>${options}`;
      if (approvedCustomers().some((customer) => customer.id === selected)) select.value = selected;
    });
    ['billing', 'payments'].forEach((listName) => {
      const filter = byId(`${listName}-customer-filter`);
      const selected = filter.value;
      const filterOptions = data.applications.map((application) =>
        `<option value="${escapeHtml(application.id)}">${escapeHtml(customerLabel(application))}</option>`).join('');
      filter.innerHTML = `<option value="">All households / meters</option>${filterOptions}`;
      if (data.applications.some((application) => application.id === selected)) filter.value = selected;
    });
    const invoiceFilter = byId('payments-invoice-filter');
    const selectedInvoice = invoiceFilter.value;
    const invoiceFilterOptions = [...data.invoices]
      .sort((first, second) => second.date.localeCompare(first.date))
      .map((invoice) => {
        const application = data.applications.find((entry) => entry.id === invoice.customerId);
        return `<option value="${escapeHtml(invoice.id)}">${escapeHtml(invoice.invoiceNumber)} · ${escapeHtml(application ? customerLabel(application) : 'Customer')}</option>`;
      }).join('');
    invoiceFilter.innerHTML = `<option value="">All invoices</option>${invoiceFilterOptions}`;
    if (data.invoices.some((invoice) => invoice.id === selectedInvoice)) invoiceFilter.value = selectedInvoice;
    renderPaymentInvoiceOptions();
  }

  function openCustomerDetails(customerId) {
    const application = data.applications.find((entry) => entry.id === customerId && entry.status === 'Approved');
    if (!application) return;
    activeCustomerDetailsId = customerId;
    customerDetailPages.invoices = 0;
    customerDetailPages.payments = 0;
    renderCustomerDetails(application);
    byId('customer-detail-dialog').showModal();
  }

  function renderCustomerDetails(application) {
    const customerId = application.id;
    const invoices = data.invoices
      .filter((invoice) => invoice.customerId === customerId)
      .sort((first, second) => second.date.localeCompare(first.date) || second.invoiceNumber.localeCompare(first.invoiceNumber));
    const invoicePageCount = Math.max(1, Math.ceil(invoices.length / HISTORY_PAGE_SIZE));
    customerDetailPages.invoices = Math.min(customerDetailPages.invoices, invoicePageCount - 1);
    const visibleInvoices = invoices.slice(
      customerDetailPages.invoices * HISTORY_PAGE_SIZE,
      (customerDetailPages.invoices + 1) * HISTORY_PAGE_SIZE
    );
    const invoiceRows = visibleInvoices.map((invoice) => {
      const invoicePayments = data.payments.filter((payment) => payment.invoiceId === invoice.id);
      const paid = invoicePayments.reduce((total, payment) => total + Number(payment.amount || 0), 0);
      const balance = Number(invoice.amount) - paid;
      return `<tr><td>${escapeHtml(displayDate(invoice.date))}</td><td>${escapeHtml(invoice.invoiceNumber)}</td>
        <td>${money(invoice.amount)}</td><td>${money(paid)}</td><td><strong>${money(balance)}</strong></td></tr>`;
    }).join('');
    const payments = data.payments
      .filter((payment) => payment.customerId === customerId)
      .map((payment) => {
        const invoice = data.invoices.find((entry) => entry.id === payment.invoiceId);
        return {
          date: payment.date,
          type: 'Payment',
          receipt: payment.receipt ? `Receipt ${payment.receipt}` : '—',
          invoiceNumber: invoice ? invoice.invoiceNumber : 'Unlinked (historical)',
          amount: Number(payment.amount)
        };
      });
    if (application.connectionReceipt && Number(application.connectionFee) > 0) {
      payments.push({
        date: application.approvedDate || application.createdAt.slice(0, 10),
        type: 'Connection fee',
        receipt: `Receipt ${application.connectionReceipt}`,
        invoiceNumber: '—',
        amount: Number(application.connectionFee)
      });
    }
    payments.sort((first, second) => second.date.localeCompare(first.date));
    const paymentPageCount = Math.max(1, Math.ceil(payments.length / HISTORY_PAGE_SIZE));
    customerDetailPages.payments = Math.min(customerDetailPages.payments, paymentPageCount - 1);
    const visiblePayments = payments.slice(
      customerDetailPages.payments * HISTORY_PAGE_SIZE,
      (customerDetailPages.payments + 1) * HISTORY_PAGE_SIZE
    );
    const paymentRows = visiblePayments.map((payment) => `<tr><td>${escapeHtml(displayDate(payment.date))}</td>
      <td>${escapeHtml(payment.type)}</td><td>${escapeHtml(payment.receipt)}</td>
      <td>${escapeHtml(payment.invoiceNumber)}</td><td><strong>${money(payment.amount)}</strong></td></tr>`).join('');
    const invoiceStart = invoices.length ? customerDetailPages.invoices * HISTORY_PAGE_SIZE + 1 : 0;
    const invoiceEnd = Math.min((customerDetailPages.invoices + 1) * HISTORY_PAGE_SIZE, invoices.length);
    const paymentStart = payments.length ? customerDetailPages.payments * HISTORY_PAGE_SIZE + 1 : 0;
    const paymentEnd = Math.min((customerDetailPages.payments + 1) * HISTORY_PAGE_SIZE, payments.length);
    byId('customer-detail-title').textContent = nameOf(application);
    byId('customer-detail-subtitle').textContent = `${customerLabel(application)} · Account balance ${money(customerBalance(customerId))}`;
    byId('customer-detail-content').innerHTML = `
      <section class="customer-ledger-section">
        <h3>Invoices (${invoices.length})</h3>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Invoice</th><th>Amount</th><th>Paid</th><th>Balance</th></tr></thead>
          <tbody>${invoiceRows}</tbody></table></div>
        ${invoices.length ? '' : '<p class="customer-ledger-empty">No invoices have been generated for this account.</p>'}
        <nav class="pagination customer-ledger-pagination" aria-label="Customer invoice pages">
          <span class="pagination-summary">Showing ${invoiceStart}–${invoiceEnd} of ${invoices.length}</span>
          ${invoicePageCount > 1 ? `<div class="pagination-controls">
            <button class="button button-secondary" type="button" data-customer-ledger-page="invoices" data-page-delta="-1" ${customerDetailPages.invoices === 0 ? 'disabled' : ''}>Previous</button>
            <span>Page ${customerDetailPages.invoices + 1} of ${invoicePageCount}</span>
            <button class="button button-secondary" type="button" data-customer-ledger-page="invoices" data-page-delta="1" ${customerDetailPages.invoices >= invoicePageCount - 1 ? 'disabled' : ''}>Next</button>
          </div>` : ''}
        </nav>
      </section>
      <section class="customer-ledger-section">
        <h3>Payments (${payments.length})</h3>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Receipt</th><th>Invoice</th><th>Amount</th></tr></thead>
          <tbody>${paymentRows}</tbody></table></div>
        ${payments.length ? '' : '<p class="customer-ledger-empty">No payments have been recorded for this account.</p>'}
        <nav class="pagination customer-ledger-pagination" aria-label="Customer payment pages">
          <span class="pagination-summary">Showing ${paymentStart}–${paymentEnd} of ${payments.length}</span>
          ${paymentPageCount > 1 ? `<div class="pagination-controls">
            <button class="button button-secondary" type="button" data-customer-ledger-page="payments" data-page-delta="-1" ${customerDetailPages.payments === 0 ? 'disabled' : ''}>Previous</button>
            <span>Page ${customerDetailPages.payments + 1} of ${paymentPageCount}</span>
            <button class="button button-secondary" type="button" data-customer-ledger-page="payments" data-page-delta="1" ${customerDetailPages.payments >= paymentPageCount - 1 ? 'disabled' : ''}>Next</button>
          </div>` : ''}
        </nav>
      </section>`;
  }

  function renderPaymentInvoiceOptions() {
    const invoiceSelect = byId('invoice-select');
    const selectedInvoice = invoiceSelect.value;
    const invoiceOptions = [...data.invoices]
      .sort((first, second) => second.date.localeCompare(first.date))
      .map((invoice) => {
        const application = data.applications.find((entry) => entry.id === invoice.customerId);
        const remaining = invoiceBalance(invoice.id);
        const balanceLabel = remaining < 0
          ? `Credit ${money(Math.abs(remaining))}`
          : `Due ${money(remaining)}`;
        return `<option value="${escapeHtml(invoice.id)}">${escapeHtml(invoice.invoiceNumber)} · ${escapeHtml(application ? customerLabel(application) : 'Customer')} · ${escapeHtml(balanceLabel)}</option>`;
      }).join('');
    invoiceSelect.innerHTML = `<option value="">Choose an invoice</option>${invoiceOptions}`;
    if (data.invoices.some((invoice) => invoice.id === selectedInvoice)) invoiceSelect.value = selectedInvoice;
  }

  function renderBilling() {
    byId('tariff-summary').textContent = `Tariff: ${money(data.tariff)} / unit`;
    renderHistoryTable(billingEvents(), 'billing');
    updateReadingPreview();
  }

  function renderPayments() {
    renderHistoryTable(paymentEvents(), 'payments');
  }

  function renderHistoryTable(events, listName) {
    const tableId = listName === 'billing' ? 'billing-table' : 'payments-table';
    const emptyId = listName === 'billing' ? 'billing-empty' : 'payments-empty';
    const paginationId = listName === 'billing' ? 'billing-pagination' : 'payments-pagination';
    const fromDate = byId(`${listName}-date-from`).value;
    const toDate = byId(`${listName}-date-to`).value;
    const customerId = byId(`${listName}-customer-filter`).value;
    const invoiceId = listName === 'payments' ? byId('payments-invoice-filter').value : '';
    const filteredEvents = events.filter((event) =>
      (!fromDate || event.date >= fromDate)
      && (!toDate || event.date <= toDate)
      && (!customerId || event.customerId === customerId)
      && (!invoiceId || event.invoiceId === invoiceId));
    const pageCount = Math.max(1, Math.ceil(filteredEvents.length / HISTORY_PAGE_SIZE));
    historyPages[listName] = Math.min(historyPages[listName], pageCount - 1);
    const start = historyPages[listName] * HISTORY_PAGE_SIZE;
    const visibleEvents = filteredEvents.slice(start, start + HISTORY_PAGE_SIZE);
    byId(tableId).innerHTML = visibleEvents.map((event) => {
      const customer = data.applications.find((application) => application.id === event.customerId);
      const receiptDetails = escapeHtml(event.detail);
      return `<tr><td>${escapeHtml(displayDate(event.date))}</td><td><strong>${escapeHtml(customer ? customerLabel(customer) : 'Customer')}</strong></td>
        <td>${escapeHtml(event.type)}</td><td>${receiptDetails}</td><td>${escapeHtml(event.invoiceNumber || '—')}</td><td><strong>${money(event.amount)}</strong></td></tr>`;
    }).join('');
    byId(emptyId).classList.toggle('visible', filteredEvents.length === 0);
    const firstItem = filteredEvents.length ? start + 1 : 0;
    const lastItem = Math.min(start + HISTORY_PAGE_SIZE, filteredEvents.length);
    byId(paginationId).innerHTML = `<span class="pagination-summary">Showing ${firstItem}–${lastItem} of ${filteredEvents.length}</span>${
      pageCount > 1 ? `<div class="pagination-controls">
        <button class="button button-secondary" type="button" data-history-page="${listName}" data-page-delta="-1" ${historyPages[listName] === 0 ? 'disabled' : ''}>Previous</button>
        <span>Page ${historyPages[listName] + 1} of ${pageCount}</span>
        <button class="button button-secondary" type="button" data-history-page="${listName}" data-page-delta="1" ${historyPages[listName] >= pageCount - 1 ? 'disabled' : ''}>Next</button>
      </div>` : ''}`;
  }

  function renderSettings() {
    byId('tariff-input').value = String(data.tariff);
    byId('chairperson-name-input').value = data.chairpersonName;
  }

  function renderAll() {
    renderHouseholdOptions();
    renderDashboard();
    renderApplications();
    renderCustomers();
    renderBilling();
    renderPayments();
    renderSettings();
  }

  function updateReadingPreview() {
    const select = document.querySelector('#reading-form [name="customerId"]');
    const selected = data.applications.find((application) => application.id === select.value);
    const preview = byId('reading-preview');
    if (!selected) {
      preview.textContent = `Choose a customer to see the last reading. Tariff: ${money(data.tariff)} per unit.`;
      return;
    }
    preview.innerHTML = `Previous meter reading: <strong>${escapeHtml(lastReadingFor(selected).toLocaleString('en'))}</strong> units · Tariff: <strong>${money(data.tariff)}</strong> / unit`;
  }

  function showView(viewName) {
    document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${viewName}`));
    document.querySelectorAll('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === viewName));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderHouseholdOptions() {
    const select = byId('household-select');
    const selected = select.value;
    const options = data.households.map((household) => {
      const label = `${[household.firstName, household.surname].filter(Boolean).join(' ')} · ${household.siteAddress || household.id}`;
      return `<option value="${escapeHtml(household.id)}">${escapeHtml(label)}</option>`;
    }).join('');
    select.innerHTML = `<option value="">Choose a household</option>${options}`;
    if (data.households.some((household) => household.id === selected)) select.value = selected;
    updateHouseholdSummary();
  }

  function updateHouseholdSummary() {
    const household = data.households.find((entry) => entry.id === byId('household-select').value);
    const summary = byId('household-summary');
    summary.hidden = !household || byId('household-mode').value !== 'existing';
    if (household) {
      summary.textContent = `Account holder: ${[household.firstName, household.initials, household.surname].filter(Boolean).join(' ')} · ${household.siteAddress || 'No address recorded'} · ${data.applications.filter((application) => application.householdId === household.id).length} existing meter application(s).`;
    }
  }

  function updateHouseholdMode() {
    const existing = byId('household-mode').value === 'existing' && data.households.length > 0;
    byId('household-fields').disabled = existing;
    byId('existing-household-picker').hidden = !existing;
    byId('household-select').disabled = !existing;
    if (byId('household-mode').value === 'existing' && !data.households.length) {
      byId('household-mode').value = 'new';
      showToast('There are no households yet. Register the first household before adding another meter.', true);
    }
    updateHouseholdSummary();
  }

  function openApplicationDialog() {
    const form = byId('application-form');
    form.reset();
    form.elements.connectionFee.value = '0';
    form.elements.initialReading.value = '0';
    byId('household-mode').value = 'new';
    updateHouseholdMode();
    byId('application-dialog').showModal();
  }

  async function submitApplication(form) {
    const formData = new FormData(form);
    const now = new Date();
    const id = crypto.randomUUID();
    const usesExistingHousehold = formData.get('householdMode') === 'existing';
    const selectedHousehold = usesExistingHousehold
      ? data.households.find((household) => household.id === formData.get('householdId'))
      : null;
    if (usesExistingHousehold && !selectedHousehold) {
      showToast('Choose an existing household for this meter application.', true);
      return;
    }
    const newHousehold = usesExistingHousehold ? null : {
      id: crypto.randomUUID(),
      createdAt: now.toISOString(),
      surname: String(formData.get('surname') || '').trim(),
      firstName: String(formData.get('firstName') || '').trim(),
      initials: String(formData.get('initials') || '').trim(),
      dob: String(formData.get('dob') || ''),
      phone: String(formData.get('phone') || '').trim(),
      idNumber: String(formData.get('idNumber') || '').trim(),
      siteAddress: String(formData.get('siteAddress') || '').trim(),
      plotNumber: String(formData.get('plotNumber') || '').trim(),
      propertyType: String(formData.get('propertyType') || ''),
      altName: String(formData.get('altName') || '').trim(),
      altPhone: String(formData.get('altPhone') || '').trim(),
      area: String(formData.get('area') || '').trim(),
      houseNumber: String(formData.get('houseNumber') || '').trim(),
      street: String(formData.get('street') || '').trim(),
      supplyPlot: String(formData.get('supplyPlot') || '').trim()
    };
    const newApplication = {
      id,
      householdId: selectedHousehold ? selectedHousehold.id : newHousehold.id,
      applicationNumber: `BWC-${now.getFullYear()}-${id.slice(0, 8).toUpperCase()}`,
      createdAt: now.toISOString(),
      status: 'Pending',
      connectionType: String(formData.get('connectionType') || ''),
      meterSize: String(formData.get('meterSize') || '').trim(),
      purposes: formData.getAll('purpose').map(String),
      purposeOther: String(formData.get('purposeOther') || '').trim(),
      documents: {
        id: formData.has('docId'),
        passport: formData.has('docPassport'),
        ownership: formData.has('docOwnership')
      },
      connectionFee: Number(formData.get('connectionFee') || 0),
      connectionReceipt: String(formData.get('connectionReceipt') || '').trim(),
      meterNumber: String(formData.get('meterNumber') || '').trim(),
      initialReading: Number(formData.get('initialReading') || 0)
    };
    if (!Number.isFinite(newApplication.connectionFee) || newApplication.connectionFee < 0
      || !Number.isFinite(newApplication.initialReading) || newApplication.initialReading < 0) {
      showToast('Enter valid non-negative amounts and meter readings.', true);
      return;
    }
    const nextData = {
      ...data,
      households: newHousehold ? [...data.households, newHousehold] : data.households,
      applications: [...data.applications, newApplication]
    };
    if (await commit(nextData, 'Application submitted for VDC review.')) {
      form.reset();
    }
  }

  async function approveApplication(applicationId) {
    const application = data.applications.find((entry) => entry.id === applicationId);
    if (!application || application.status !== 'Pending') return;
    const approverName = byId('approver-name').value.trim();
    if (!approverName) {
      byId('approver-name').focus();
      showToast('Enter the VDC chairperson name to record this approval.', true);
      return;
    }
    const nextApplications = data.applications.map((entry) => entry.id === applicationId
      ? { ...entry, status: 'Approved', approvedDate: today, approverName }
      : entry);
    if (await commit({ ...data, applications: nextApplications }, `${nameOf(application)} is now an approved customer.`)) {
      openReview(applicationId);
    }
  }

  async function rejectApplication(applicationId) {
    const application = data.applications.find((entry) => entry.id === applicationId);
    if (!application || application.status !== 'Pending') return;
    if (!window.confirm(`Mark the application for ${nameOf(application)} as rejected?`)) return;
    const nextApplications = data.applications.map((entry) => entry.id === applicationId
      ? { ...entry, status: 'Rejected', rejectedDate: today }
      : entry);
    if (await commit({ ...data, applications: nextApplications }, 'Application marked as rejected.')) {
      openReview(applicationId);
    }
  }

  function reviewField(label, value) {
    return `<div class="review-item"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value || '—')}</strong></div>`;
  }

  function openReview(applicationId, editing) {
    const application = data.applications.find((entry) => entry.id === applicationId);
    if (!application) return;
    const household = householdFor(application);
    if (editing) {
      renderApplicationEditor(application, household);
      if (!byId('review-dialog').open) byId('review-dialog').showModal();
      return;
    }
    const purposes = [...(application.purposes || [])];
    if (purposes.includes('Other') && application.purposeOther) purposes.push(application.purposeOther);
    const docs = application.documents || {};
    const statusClass = application.status.toLowerCase();
    byId('review-subtitle').textContent = `${application.applicationNumber} · Submitted ${displayDate(application.createdAt.slice(0, 10))}`;
    byId('review-content').innerHTML = `
      <div class="review-section"><h3>Applicant information</h3><div class="review-grid">
        ${reviewField('Household account holder', nameOf(application))}${reviewField('Date of birth', displayDate(household && household.dob))}
        ${reviewField('Phone number', household && household.phone)}${reviewField('ID / passport number', household && household.idNumber)}
      </div></div>
      <div class="review-section"><h3>Household property &amp; meter connection</h3><div class="review-grid">
        ${reviewField('Exact site address', household && household.siteAddress)}${reviewField('Plot / land number', household && household.plotNumber)}
        ${reviewField('Property type', household && household.propertyType)}${reviewField('Connection type', application.connectionType)}
        ${reviewField('Meter size requested', application.meterSize)}${reviewField('Purpose of water use', purposes.join(', '))}
        ${reviewField('Location / house', household && [household.area, household.houseNumber, household.street, household.supplyPlot].filter(Boolean).join(' · '))}
      </div></div>
      <div class="review-section"><h3>Documentation checklist</h3><div class="review-grid">
        ${reviewField('Copy of ID', docs.id ? 'Received' : 'Not recorded')}${reviewField('Copy of passport', docs.passport ? 'Received' : 'Not recorded')}
        ${reviewField('Proof of ownership', docs.ownership ? 'Received' : 'Not recorded')}
      </div></div>
      <div class="review-section"><h3>Fee, contacts &amp; supply location</h3><div class="review-grid">
        ${reviewField('Connection fee payable', money(application.connectionFee))}${reviewField('Connection fee receipt', application.connectionReceipt)}
        ${reviewField('Alternative contact', household && [household.altName, household.altPhone].filter(Boolean).join(' · '))}
        ${reviewField('Meter number', application.meterNumber)}${reviewField('Initial meter reading', Number(application.initialReading || 0).toLocaleString('en'))}
      </div></div>
      <div class="review-section"><h3>Customer declaration</h3><div class="review-grid">
        ${reviewField('Terms accepted', 'Yes')}
      </div></div>
      <div class="review-section"><h3>VDC decision</h3><div class="review-grid">
        ${reviewField('Status', application.status)}
        ${application.status === 'Approved' ? `${reviewField('Approved by', application.approverName)}${reviewField('Approval date', displayDate(application.approvedDate))}` : ''}
        ${application.status === 'Rejected' ? reviewField('Decision date', displayDate(application.rejectedDate)) : ''}
      </div></div>`;
    byId('review-footer').classList.add('dialog-footer', 'review-footer');
    byId('review-footer').innerHTML = application.status === 'Pending'
      ? `<button class="button button-secondary" type="button" data-edit-application="${escapeHtml(application.id)}">Edit application</button><span class="review-decision">Applicant and VDC signatures must be completed offline.</span><div class="review-approval"><label>VDC chairperson name<input id="approver-name" maxlength="100" value="${escapeHtml(data.chairpersonName)}" required></label><button class="button button-secondary" type="button" data-reject="${escapeHtml(application.id)}">Reject</button><button class="button button-primary" type="button" data-confirm-approval="${escapeHtml(application.id)}">Approve connection</button></div>`
      : `<button class="button button-secondary" type="button" data-edit-application="${escapeHtml(application.id)}">Edit application</button><span class="status status-${statusClass}">${escapeHtml(application.status)}</span><span class="review-decision">Applicant and VDC signatures must be completed offline.</span>`;
    if (!byId('review-dialog').open) byId('review-dialog').showModal();
  }

  function renderApplicationEditor(application, household) {
    const docs = application.documents || {};
    byId('review-subtitle').textContent = `${application.applicationNumber} · Edit application details`;
    byId('review-content').innerHTML = `
      <form class="application-edit-form" id="review-edit-form" data-edit-application-form="${escapeHtml(application.id)}">
        <section class="review-section"><h3>Household contact</h3><div class="form-row three-col">
          <label>Surname<input name="surname" required maxlength="80" value="${escapeHtml(household && household.surname)}"></label>
          <label>First name<input name="firstName" required maxlength="80" value="${escapeHtml(household && household.firstName)}"></label>
          <label>Initial(s)<input name="initials" maxlength="20" value="${escapeHtml(household && household.initials)}"></label>
        </div><div class="form-row three-col">
          <label>Date of birth<input name="dob" type="date" value="${escapeHtml(household && household.dob)}"></label>
          <label>Phone number<input name="phone" type="tel" required maxlength="40" value="${escapeHtml(household && household.phone)}"></label>
          <label>ID / passport number<input name="idNumber" maxlength="80" value="${escapeHtml(household && household.idNumber)}"></label>
        </div><div class="form-row">
          <label>Alternative contact name<input name="altName" maxlength="100" value="${escapeHtml(household && household.altName)}"></label>
          <label>Alternative contact number<input name="altPhone" type="tel" maxlength="40" value="${escapeHtml(household && household.altPhone)}"></label>
        </div></section>
        <section class="review-section"><h3>Property and meter</h3>
          <label>Exact site address<input name="siteAddress" required maxlength="180" value="${escapeHtml(household && household.siteAddress)}"></label>
          <div class="form-row"><label>Plot / land number<input name="plotNumber" maxlength="80" value="${escapeHtml(household && household.plotNumber)}"></label>
            <label>Property type<select name="propertyType"><option ${household && household.propertyType === 'New property' ? 'selected' : ''}>New property</option><option ${household && household.propertyType === 'Existing property' ? 'selected' : ''}>Existing property</option></select></label></div>
          <div class="form-row"><label>Location / area<input name="area" maxlength="100" value="${escapeHtml(household && household.area)}"></label>
            <label>House number<input name="houseNumber" maxlength="60" value="${escapeHtml(household && household.houseNumber)}"></label></div>
          <div class="form-row"><label>Street<input name="street" maxlength="100" value="${escapeHtml(household && household.street)}"></label>
            <label>Supply plot number<input name="supplyPlot" maxlength="80" value="${escapeHtml(household && household.supplyPlot)}"></label></div>
          <div class="form-row"><label>Connection type<select name="connectionType">
            <option ${application.connectionType === 'Residential' ? 'selected' : ''}>Residential</option>
            <option ${application.connectionType === 'Commercial' ? 'selected' : ''}>Commercial</option>
            <option ${application.connectionType === 'Industrial' ? 'selected' : ''}>Industrial</option>
          </select></label><label>Meter size requested<input name="meterSize" maxlength="60" value="${escapeHtml(application.meterSize)}"></label></div>
          <div class="form-row"><label>Meter number<input name="meterNumber" maxlength="60" value="${escapeHtml(application.meterNumber)}"></label>
            <label>Initial meter reading<input name="initialReading" type="number" min="0" step="any" value="${escapeHtml(application.initialReading || 0)}"></label></div>
        </section>
        <section class="review-section"><h3>Water use and documents</h3>
          <fieldset class="choice-field"><legend>Purpose of water use</legend>
            <label class="check-option"><input type="checkbox" name="purpose" value="Drinking" ${application.purposes && application.purposes.includes('Drinking') ? 'checked' : ''}> Drinking</label>
            <label class="check-option"><input type="checkbox" name="purpose" value="Irrigation" ${application.purposes && application.purposes.includes('Irrigation') ? 'checked' : ''}> Irrigation</label>
            <label class="check-option"><input type="checkbox" name="purpose" value="Other" ${application.purposes && application.purposes.includes('Other') ? 'checked' : ''}> Other</label>
            <input name="purposeOther" class="other-purpose" maxlength="80" placeholder="Describe other purpose" aria-label="Other water use" value="${escapeHtml(application.purposeOther)}">
          </fieldset>
          <div class="check-list"><label class="check-option"><input type="checkbox" name="docId" ${docs.id ? 'checked' : ''}> Copy of ID received</label>
            <label class="check-option"><input type="checkbox" name="docPassport" ${docs.passport ? 'checked' : ''}> Copy of passport received</label>
            <label class="check-option"><input type="checkbox" name="docOwnership" ${docs.ownership ? 'checked' : ''}> Proof of property ownership received</label></div>
        </section>
        <section class="review-section"><h3>Connection fee</h3><div class="form-row">
          <label>Amount payable (GMD)<input name="connectionFee" type="number" min="0" step="0.01" value="${escapeHtml(application.connectionFee || 0)}"></label>
          <label>Receipt number<input name="connectionReceipt" maxlength="60" value="${escapeHtml(application.connectionReceipt)}"></label>
        </div></section>
      </form>`;
    byId('review-footer').classList.add('dialog-footer', 'review-footer');
    byId('review-footer').innerHTML = `<span class="review-decision">Household contact and property edits apply to all meters linked to this household.</span>
      <div><button class="button button-secondary" type="button" data-cancel-application-edit="${escapeHtml(application.id)}">Cancel</button>
      <button class="button button-primary" type="submit" form="review-edit-form">Save changes</button></div>`;
  }

  async function saveApplicationEdits(form) {
    const applicationId = form.dataset.editApplicationForm;
    const application = data.applications.find((entry) => entry.id === applicationId);
    const household = application && householdFor(application);
    if (!application || !household) {
      showToast('Could not find this application or its household record.', true);
      return;
    }
    const formData = new FormData(form);
    const connectionFee = Number(formData.get('connectionFee'));
    const initialReading = Number(formData.get('initialReading'));
    if (!Number.isFinite(connectionFee) || connectionFee < 0 || !Number.isFinite(initialReading) || initialReading < 0) {
      showToast('Enter valid non-negative amounts and meter readings.', true);
      return;
    }
    const updatedHousehold = {
      ...household,
      surname: String(formData.get('surname') || '').trim(),
      firstName: String(formData.get('firstName') || '').trim(),
      initials: String(formData.get('initials') || '').trim(),
      dob: String(formData.get('dob') || ''),
      phone: String(formData.get('phone') || '').trim(),
      idNumber: String(formData.get('idNumber') || '').trim(),
      siteAddress: String(formData.get('siteAddress') || '').trim(),
      plotNumber: String(formData.get('plotNumber') || '').trim(),
      propertyType: String(formData.get('propertyType') || ''),
      altName: String(formData.get('altName') || '').trim(),
      altPhone: String(formData.get('altPhone') || '').trim(),
      area: String(formData.get('area') || '').trim(),
      houseNumber: String(formData.get('houseNumber') || '').trim(),
      street: String(formData.get('street') || '').trim(),
      supplyPlot: String(formData.get('supplyPlot') || '').trim()
    };
    const updatedApplication = {
      ...application,
      connectionType: String(formData.get('connectionType') || ''),
      meterSize: String(formData.get('meterSize') || '').trim(),
      purposes: formData.getAll('purpose').map(String),
      purposeOther: String(formData.get('purposeOther') || '').trim(),
      documents: {
        id: formData.has('docId'),
        passport: formData.has('docPassport'),
        ownership: formData.has('docOwnership')
      },
      connectionFee: Math.round(connectionFee * 100) / 100,
      connectionReceipt: String(formData.get('connectionReceipt') || '').trim(),
      meterNumber: String(formData.get('meterNumber') || '').trim(),
      initialReading
    };
    const nextData = {
      ...data,
      households: data.households.map((entry) => entry.id === household.id ? updatedHousehold : entry),
      applications: data.applications.map((entry) => entry.id === applicationId ? updatedApplication : entry)
    };
    if (await commit(nextData, `Application ${application.applicationNumber} updated.`)) openReview(applicationId);
  }

  async function saveReading(form) {
    const formData = new FormData(form);
    const customerId = String(formData.get('customerId') || '');
    const application = data.applications.find((entry) => entry.id === customerId && entry.status === 'Approved');
    const readingValue = Number(formData.get('reading'));
    const date = String(formData.get('date') || '');
    if (!application || !Number.isFinite(readingValue) || readingValue < 0 || !date) {
      showToast('Choose an approved customer and enter a valid reading and date.', true);
      return;
    }
    const previousReading = lastReadingFor(application);
    const existingReadings = readingsFor(customerId);
    const readingMonth = date.slice(0, 7);
    if (existingReadings.some((reading) => reading.date.slice(0, 7) === readingMonth)) {
      const monthLabel = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date(`${readingMonth}-01T00:00:00`));
      showToast(`A reading has already been recorded for this meter in ${monthLabel}. Only one reading per meter is allowed each month.`, true);
      return;
    }
    const latestReading = existingReadings[existingReadings.length - 1];
    if (readingValue < previousReading) {
      showToast(`Reading cannot be lower than the previous reading (${previousReading}).`, true);
      return;
    }
    if (latestReading && date < latestReading.date) {
      showToast(`Reading date cannot be earlier than the latest recorded reading (${displayDate(latestReading.date)}).`, true);
      return;
    }
    const consumption = readingValue - previousReading;
    const reading = {
      id: crypto.randomUUID(),
      customerId,
      date,
      reading: readingValue,
      previousReading,
      consumption,
      tariff: data.tariff,
      charge: Math.round(consumption * data.tariff * 100) / 100,
      createdAt: new Date().toISOString()
    };
    const invoice = {
      id: reading.id,
      readingId: reading.id,
      invoiceNumber: invoiceNumberFor(reading.id, date),
      customerId,
      date,
      amount: reading.charge,
      createdAt: reading.createdAt
    };
    if (await commit({
      ...data,
      readings: [...data.readings, reading],
      invoices: [...data.invoices, invoice]
    }, `Reading saved and invoice ${invoice.invoiceNumber} generated for ${money(invoice.amount)}.`)) {
      form.reset();
      form.elements.date.value = today;
    }
  }

  async function savePayment(form) {
    const formData = new FormData(form);
    const invoiceId = String(formData.get('invoiceId') || '');
    const invoice = data.invoices.find((entry) => entry.id === invoiceId);
    const application = invoice
      ? data.applications.find((entry) => entry.id === invoice.customerId && entry.status === 'Approved')
      : null;
    const amount = Number(formData.get('amount'));
    const date = String(formData.get('date') || '');
    if (!invoice || !application || !Number.isFinite(amount) || amount <= 0 || !date) {
      showToast('Choose an invoice and enter a valid payment amount and date.', true);
      return;
    }
    const receiptImage = formData.get('receiptImage');
    let receiptImagePath = '';
    if (receiptImage instanceof File && receiptImage.size > 0) {
      const extension = RECEIPT_IMAGE_TYPES[receiptImage.type];
      if (!extension) {
        showToast('Receipt image must be a JPG, PNG, or WebP file.', true);
        return;
      }
      if (receiptImage.size > MAX_RECEIPT_IMAGE_SIZE) {
        showToast('Receipt image must be 5 MB or smaller.', true);
        return;
      }
      receiptImagePath = `${application.householdId}/${application.id}/${crypto.randomUUID()}.${extension}`;
      try {
        const { error } = await supabaseClient.storage.from(RECEIPT_BUCKET).upload(receiptImagePath, receiptImage, {
          contentType: receiptImage.type,
          upsert: false
        });
        if (error) throw error;
      } catch (error) {
        console.error('Unable to upload payment receipt image.', error);
        showToast('Could not upload the receipt image. Check storage setup and try again.', true);
        return;
      }
    }
    const payment = {
      id: crypto.randomUUID(),
      customerId: application.id,
      invoiceId,
      date,
      amount: Math.round(amount * 100) / 100,
      receipt: String(formData.get('receipt') || '').trim(),
      receiptImagePath,
      createdAt: new Date().toISOString()
    };
    if (await commit({ ...data, payments: [...data.payments, payment] }, `${money(payment.amount)} payment recorded for ${nameOf(application)}.`)) {
      form.reset();
      form.elements.date.value = today;
    } else if (receiptImagePath) {
      try {
        const { error } = await supabaseClient.storage.from(RECEIPT_BUCKET).remove([receiptImagePath]);
        if (error) console.error('Unable to remove an unlinked payment receipt image.', error);
      } catch (error) {
        console.error('Unable to remove an unlinked payment receipt image.', error);
      }
    }
  }

  async function saveSettings(form) {
    const formData = new FormData(form);
    const tariff = Number(formData.get('tariff'));
    const chairpersonName = String(formData.get('chairpersonName') || '').trim();
    if (!Number.isFinite(tariff) || tariff < 0) {
      showToast('Enter a valid non-negative tariff.', true);
      return;
    }
    await commit({
      ...data,
      tariff: Math.round(tariff * 100) / 100,
      chairpersonName
    }, 'Workspace settings saved.');
  }

  let activeUserId = null;

  async function handleAuthStateChange(session) {
    if (!session) {
      activeUserId = null;
      storageReady = false;
      data = emptyData();
      byId('sign-out-button').hidden = true;
      byId('app-shell').hidden = true;
      byId('auth-screen').hidden = false;
      byId('auth-error').textContent = '';
      return;
    }
    if (activeUserId === session.user.id && storageReady) return;
    activeUserId = session.user.id;
    storageReady = false;
    byId('auth-screen').hidden = true;
    byId('app-shell').hidden = false;
    byId('sign-out-button').hidden = false;
    byId('workspace-status').textContent = 'Loading workspace…';
    byId('workspace-detail').textContent = session.user.email || 'Signed in';
    try {
      await loadData();
      storageReady = true;
      byId('workspace-status').textContent = 'Workspace ready';
      byId('workspace-detail').textContent = session.user.email || 'Signed in';
      renderAll();
    } catch (error) {
      console.error('Unable to load Besse Water workspace data from Supabase.', error);
      data = emptyData();
      renderAll();
      byId('workspace-status').textContent = 'Workspace unavailable';
      byId('workspace-detail').textContent = session.user.email || 'Signed in';
      showToast('Could not load the shared workspace. Check your workspace access and connection; changes are disabled.', true);
    }
  }

  function initialize() {
    byId('today-label').textContent = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
    document.querySelectorAll('[data-go-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.goView)));
    document.querySelectorAll('[data-open-application]').forEach((button) => button.addEventListener('click', openApplicationDialog));
    document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => byId('application-dialog').close()));
    document.querySelector('[data-close-review]').addEventListener('click', () => byId('review-dialog').close());
    document.querySelectorAll('[data-close-customer-details]').forEach((button) => {
      button.addEventListener('click', () => byId('customer-detail-dialog').close());
    });
    byId('household-mode').addEventListener('change', updateHouseholdMode);
    byId('household-select').addEventListener('change', updateHouseholdSummary);
    byId('application-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (event.currentTarget.reportValidity()) await submitApplication(event.currentTarget);
    });
    byId('review-content').addEventListener('submit', async (event) => {
      if (event.target.id !== 'review-edit-form') return;
      event.preventDefault();
      if (event.target.reportValidity()) await saveApplicationEdits(event.target);
    });
    byId('application-search').addEventListener('input', renderApplications);
    byId('customer-search').addEventListener('input', renderCustomers);
    const historyFilterInputs = [
      ['billing', 'billing-date-from'],
      ['billing', 'billing-date-to'],
      ['billing', 'billing-customer-filter'],
      ['payments', 'payments-date-from'],
      ['payments', 'payments-date-to'],
      ['payments', 'payments-customer-filter'],
      ['payments', 'payments-invoice-filter']
    ];
    historyFilterInputs.forEach(([listName, inputId]) => {
      byId(inputId).addEventListener('change', () => {
        historyPages[listName] = 0;
        if (listName === 'billing') renderBilling();
        else renderPayments();
      });
    });
    document.querySelector('#reading-form [name="customerId"]').addEventListener('change', updateReadingPreview);
    document.querySelector('#reading-form [name="reading"]').addEventListener('input', updateReadingPreview);
    byId('reading-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (event.currentTarget.reportValidity()) await saveReading(event.currentTarget);
    });
    byId('download-reading-template').addEventListener('click', downloadReadingTemplate);
    byId('bulk-reading-file').addEventListener('change', async (event) => {
      await previewBulkReadings(event.currentTarget.files[0]);
    });
    byId('import-bulk-readings').addEventListener('click', importBulkReadings);
    byId('payment-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (event.currentTarget.reportValidity()) await savePayment(event.currentTarget);
    });
    byId('settings-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (event.currentTarget.reportValidity()) await saveSettings(event.currentTarget);
    });
    document.body.addEventListener('click', (event) => {
      const pageButton = event.target.closest('[data-history-page]');
      const customerLedgerPageButton = event.target.closest('[data-customer-ledger-page]');
      const customerDetailsButton = event.target.closest('[data-customer-details]');
      const reviewButton = event.target.closest('[data-review]');
      const editApplicationButton = event.target.closest('[data-edit-application]');
      const cancelApplicationEditButton = event.target.closest('[data-cancel-application-edit]');
      const clearHistoryFiltersButton = event.target.closest('[data-clear-history-filters]');
      const approveButton = event.target.closest('[data-confirm-approval]');
      const rejectButton = event.target.closest('[data-reject]');
      if (pageButton && !pageButton.disabled) {
        const listName = pageButton.dataset.historyPage;
        historyPages[listName] += Number(pageButton.dataset.pageDelta);
        if (listName === 'billing') renderBilling();
        else renderPayments();
      }
      if (clearHistoryFiltersButton) {
        const listName = clearHistoryFiltersButton.dataset.clearHistoryFilters;
        byId(`${listName}-date-from`).value = '';
        byId(`${listName}-date-to`).value = '';
        byId(`${listName}-customer-filter`).value = '';
        if (listName === 'payments') byId('payments-invoice-filter').value = '';
        historyPages[listName] = 0;
        if (listName === 'billing') renderBilling();
        else renderPayments();
      }
      if (customerLedgerPageButton && !customerLedgerPageButton.disabled) {
        const listName = customerLedgerPageButton.dataset.customerLedgerPage;
        customerDetailPages[listName] += Number(customerLedgerPageButton.dataset.pageDelta);
        const application = data.applications.find((entry) => entry.id === activeCustomerDetailsId);
        if (application) renderCustomerDetails(application);
      }
      if (customerDetailsButton) openCustomerDetails(customerDetailsButton.dataset.customerDetails);
      if (reviewButton) openReview(reviewButton.dataset.review);
      if (editApplicationButton) openReview(editApplicationButton.dataset.editApplication, true);
      if (cancelApplicationEditButton) openReview(cancelApplicationEditButton.dataset.cancelApplicationEdit);
      if (approveButton) approveApplication(approveButton.dataset.confirmApproval);
      if (rejectButton) rejectApplication(rejectButton.dataset.reject);
    });
    document.querySelectorAll('#reading-form [name="date"], #payment-form [name="date"]').forEach((input) => { input.value = today; });
    byId('tariff-input').name = 'tariff';

    byId('sign-in-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      byId('auth-error').textContent = '';
      if (!supabaseClient) {
        byId('auth-error').textContent = 'Supabase is not initialized. Check the project API URL, anon key, and connection, then reload.';
        return;
      }
      try {
        const { error } = await supabaseClient.auth.signInWithPassword({
          email: String(formData.get('email') || '').trim(),
          password: String(formData.get('password') || '')
        });
        if (error) throw error;
      } catch (error) {
        console.error('Unable to sign in to Besse Water.', error);
        byId('auth-error').textContent = 'Sign-in failed. Check your email and password, then try again.';
      }
    });
    byId('sign-out-button').addEventListener('click', async () => {
      if (!supabaseClient) {
        showToast('Supabase is not initialized. Check the project configuration.', true);
        return;
      }
      try {
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
      } catch (error) {
        console.error('Unable to sign out of Besse Water.', error);
        showToast('Could not sign out. Please try again.', true);
      }
    });

    const config = window.BESSE_SUPABASE_CONFIG;
    if (!window.supabase || !config || !config.url || !config.anonKey) {
      byId('app-shell').hidden = true;
      byId('auth-screen').hidden = false;
      byId('auth-error').textContent = 'Supabase is not configured. Add the project API URL and anon key to supabase-config.js.';
      return;
    }
    try {
      supabaseClient = window.supabase.createClient(config.url, config.anonKey);
    } catch (error) {
      console.error('Invalid Supabase configuration.', error);
      byId('app-shell').hidden = true;
      byId('auth-screen').hidden = false;
      byId('auth-error').textContent = 'Supabase configuration is invalid. Use the HTTPS project API URL (not a PostgreSQL connection string) and the anon key.';
      return;
    }
    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event)) {
        window.setTimeout(() => handleAuthStateChange(session), 0);
      }
    });
  }

  initialize();
}());
