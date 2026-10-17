import { formatNumber, formatDate, toExcelDateSerial, formatDateForInput } from '../../utils/formatters.js';

// A value only qualifies for date conversion when it actually looks like a
// date (Date instance, Firestore Timestamp, or a date-shaped string).
// Summary rows reuse the report grid, so plain numbers sitting under a Date
// header (EOD bank-summary amounts) must stay amounts — new Date(50000) would
// "succeed" as Jan 1970 and destroy the figure.
function looksLikeDate(val) {
    if (val instanceof Date) return !isNaN(val.getTime())
    if (typeof val === 'object' && val !== null) {
        if (typeof val.toDate === 'function') return true
        if (val.seconds !== undefined || val._seconds !== undefined) return true
        return false
    }
    if (typeof val !== 'string') return false
    const s = val.trim()
    if (!s) return false
    if (/[a-zA-Z]{3,}/.test(s)) return !isNaN(new Date(s).getTime())
    return /\d{4}-\d{1,2}-\d{1,2}/.test(s) || /\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}/.test(s)
}

export async function exportToExcel(cooperativeName, title, headers, data) {
    const ExcelJS = window.ExcelJS || (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Report');

    worksheet.mergeCells(1, 1, 1, headers.length);
    const coopCell = worksheet.getCell(1, 1);
    coopCell.value = cooperativeName;
    coopCell.font = { size: 18, bold: true };
    coopCell.alignment = { horizontal: 'center' };

    worksheet.mergeCells(2, 1, 2, headers.length);
    const titleCell = worksheet.getCell(2, 1);
    titleCell.value = title;
    titleCell.font = { size: 14, bold: true };
    titleCell.alignment = { horizontal: 'center' };

    worksheet.getRow(4).values = headers;
    worksheet.getRow(4).font = { bold: true };
    worksheet.getRow(4).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };

    data.forEach((row, idx) => {
        const r = worksheet.getRow(idx + 5);
        const rowArray = Array.isArray(row) ? row : headers.map(h => row[h]);

        rowArray.forEach((val, colIdx) => {
            const cell = r.getCell(colIdx + 1);
            const header = headers[colIdx];

            if ((header === 'Date Joined' || header === 'Date') && val !== '' && val !== null && val !== undefined) {
                if (typeof val === 'number') {
                    // Amount from a summary row sitting under a Date header —
                    // keep it an amount, formatted like the preview figures.
                    cell.value = val;
                    cell.numFmt = '#,##0.00';
                } else if (looksLikeDate(val)) {
                    // Real Excel date (serial integer, no time fraction) so formulas
                    // work, built from the calendar day with pure arithmetic — same
                    // day the preview/PDF show, immune to timezone shifts.
                    const serial = toExcelDateSerial(val);
                    if (serial !== null) {
                        cell.value = serial;
                        cell.numFmt = 'dd mmm, yyyy';
                    } else {
                        cell.value = val;
                    }
                } else {
                    cell.value = val;
                }
            } else if (val !== undefined && (header === 'Amount' || header === 'Total' || header === 'Principal' || header === 'Bal B/F' || ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].includes(header))) {
                const numVal = (val === null || val === undefined || val === '') ? 0 : Number(val);
                cell.value = numVal;
                cell.numFmt = numVal % 1 === 0 ? '#,##0;[Red]-#,##0' : '#,##0.00;[Red]-#,##0.00';
                cell.alignment = { horizontal: 'right' };
            } else {
                cell.value = val;
            }
        });
    });

    worksheet.columns.forEach(column => {
        let maxLen = 0;
        column.eachCell({ includeEmpty: true }, cell => {
            const len = cell.value ? String(cell.value).length : 0;
            if (len > maxLen) maxLen = len;
        });
        column.width = Math.min(30, maxLen + 2);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^a-z0-9]/gi, '_')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
}

export async function exportToPDF(cooperativeName, title, headers, data, orientation = 'p', username = 'System', noWrap = false) {
    const loadScript = (url) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });

    try {
        if (!window.jspdf) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        }
        if (!window.jspdf.jsPDF.API.autoTable) {
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js');
        }

        let jsPDF;
        if (window.jspdf && window.jspdf.jsPDF) {
            jsPDF = window.jspdf.jsPDF;
        } else if (typeof window.jsPDF === 'function') {
            jsPDF = window.jsPDF;
        } else {
            throw new Error('jsPDF library loaded but constructor not found.');
        }

        const doc = new jsPDF({
            orientation: 'l',
            unit: 'mm',
            format: 'a4'
        });

        const pageWidth = doc.internal.pageSize.getWidth();
        const now = new Date();
        const timestamp = now.toLocaleString();

        const addHeader = () => {
            doc.setFontSize(14);
            doc.setTextColor(40);
            doc.setFont('helvetica', 'bold');
            doc.text(cooperativeName, pageWidth / 2, 15, { align: 'center' });
            doc.setFontSize(12);
            doc.text(title, pageWidth / 2, 22, { align: 'center' });
        };

        doc.autoTable({
            head: [headers],
            body: data.map(row => {
                const rowArray = Array.isArray(row) ? row : headers.map(h => row[h]);
                return rowArray.map((val, idx) => {
                    const header = headers[idx];
                    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    const commonAmountHeaders = ['Amount', 'Total', 'Principal', 'Bal B/F', 'DR', 'CR', 'BL', 'Balance'];
                    const isAmount = typeof val === 'number' || commonAmountHeaders.includes(header) || monthNames.includes(header);

                    if (isAmount) {
                        const numVal = (val === null || val === undefined || val === '') ? 0 : Number(val);
                        return {
                            content: formatNumber(numVal),
                            styles: {
                                textColor: numVal < 0 ? [220, 38, 38] : [0, 0, 0],
                                halign: 'right'
                            }
                        };
                    }
                    return val;
                });
            }),
            startY: 30,
            theme: 'plain',
            rowPageBreak: 'avoid',
            styles: {
                lineColor: [100, 100, 100],
                lineWidth: 0.1,
                fontSize: 8,
                cellPadding: 2,
                textColor: [0, 0, 0],
                overflow: noWrap ? 'visible' : 'linebreak'
            },
            columnStyles: headers.reduce((acc, header, idx) => {
                if (noWrap) {
                    acc[idx] = { cellWidth: 'auto', overflow: 'visible' };
                    return acc;
                }
                const noWrapHeaders = ["ID", "Date", "Amount", "Total", "Principal", "Bal B/F", "Status", "Reg No", "Member ID", "Mobile", "Sex"];
                if (noWrapHeaders.includes(header)) {
                    acc[idx] = { cellWidth: 'wrap' };
                } else if (header === 'Member Name' || header === 'Full Name') {
                    acc[idx] = { cellWidth: 'auto', minCellWidth: 40 };
                } else if (header === 'Bank' || header === 'Transaction Type') {
                    acc[idx] = { cellWidth: 'auto', minCellWidth: 25 };
                }
                return acc;
            }, {}),
            headStyles: {
                fillColor: false,
                textColor: [0, 0, 0],
                fontStyle: 'bold',
                lineWidth: 0.1,
                lineColor: [100, 100, 100]
            },
            didDrawPage: (data) => {
                addHeader();
                doc.setFontSize(7);
                doc.setFont('helvetica', 'italic');
                const footerY = doc.internal.pageSize.getHeight() - 10;
                doc.text(`Printed at: ${timestamp}`, 14, footerY);
                doc.text(`Printed by: ${username}`, pageWidth / 2, footerY, { align: 'center' });
                doc.text('Powered by cooplogng', pageWidth - 14, footerY, { align: 'right' });
            },
            tableWidth: noWrap ? 'wrap' : 'auto',
            margin: { top: 30 }
        });

        doc.save(`${title.replace(/[^a-z0-9]/gi, '_')}.pdf`);
    } catch (err) {
        console.error('PDF Library Load Error:', err);
        throw new Error('Failed to load PDF libraries. Please check your internet connection.');
    }
}
