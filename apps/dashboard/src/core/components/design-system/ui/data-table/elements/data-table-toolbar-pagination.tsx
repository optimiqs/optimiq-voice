import ArrowBackIosNewIcon from "@mui/icons-material/ArrowBackIosNew";
import ArrowForwardIosIcon from "@mui/icons-material/ArrowForwardIos";
import { Box, IconButton } from "@mui/material";
import { Typography } from "../../typography/typography";
import { useDataTable } from "../data-table.context";

export const DataTableToolbarPagination = () => {
	const { pagination, features, pageSize, onNextPage, onPrevPage } = useDataTable();

	if (!features.includes("pagination")) return null;

	return (
		<Box display="flex" alignItems="center" gap="4px" paddingRight="16px">
			<IconButton
				onClick={onPrevPage}
				disabled={!pagination.prevToken}
				size="small"
				sx={{ fontSize: "16px" }}
			>
				<ArrowBackIosNewIcon fontSize="inherit" />
			</IconButton>

			<IconButton
				onClick={onNextPage}
				disabled={!pagination.nextToken}
				size="small"
				sx={{ fontSize: "16px" }}
			>
				<ArrowForwardIosIcon fontSize="inherit" />
			</IconButton>
			<Typography variant="body-micro" color="var(--optimiq-voice-palette-base-03)">
				{`1–${pageSize} of ${pagination.total}`}
			</Typography>
		</Box>
	);
};
