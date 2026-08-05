import DeleteIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/ModeEditOutline";
import { Box } from "@mui/material";
import { Checkbox } from "../../checkbox/checkbox";
import { useDataTable } from "../data-table.context";

export const DataTableToolbarSelection = () => {
  const { table, features, onDeleteSelected, onEditSelected, selectedRows } =
    useDataTable();

  const numSelected = selectedRows.length;

  if (!features.includes("selection")) return null;

  return (
    <Box
      sx={(theme) => ({
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        backgroundColor: theme.palette.base["07"],
        borderRadius: "4px",
        border: `1px solid ${theme.palette.base["06"]}`,
        background: theme.palette.base["07"],
        minHeight: "32px",
        minWidth: "32px"
      })}
    >
      <Checkbox
        indeterminate={
          table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()
        }
        checked={table.getIsAllRowsSelected()}
        onChange={() => table.toggleAllRowsSelected()}
        sx={{
          maxWidth: "32px",
          maxHeight: "32px"
        }}
      />

      {Boolean(numSelected) && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "base.02"
          }}
        >
          <Box
            component="span"
            sx={{
              height: "16px",
              width: "1px",
              backgroundColor: "base.06"
            }}
          />
          {onDeleteSelected && (
            <Box
              sx={{
                fontSize: "20px",
                cursor: "pointer",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                padding: "0px 8px"
              }}
              onClick={() => onDeleteSelected(selectedRows)}
            >
              <DeleteIcon fontSize="inherit" />
            </Box>
          )}
          {onEditSelected && numSelected === 1 && (
            <Box
              sx={{
                fontSize: "20px",
                cursor: "pointer",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                padding: "0px 10px 0px 0px"
              }}
              onClick={onEditSelected}
            >
              <EditIcon fontSize="inherit" />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
