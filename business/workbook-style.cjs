function centerWorkbook(workbook) {
  for (const sheet of workbook.worksheets) {
    sheet.pageSetup.horizontalCentered = true;
    sheet.eachRow(row => row.eachCell(cell => {
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }));
  }
}
module.exports = { centerWorkbook };
