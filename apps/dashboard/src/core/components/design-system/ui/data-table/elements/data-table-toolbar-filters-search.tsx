import SearchIcon from "@mui/icons-material/Search";
import { TextField, InputAdornment, styled } from "@mui/material";
import { useState } from "react";
import type React from "react";

export interface FilterSearchProps {
	onSearchChange: (searchText: string) => void;
	placeholder?: string;
}

const InputRoot = styled(TextField)<{ $active?: boolean }>(({ $active, theme }) => ({
	"& .MuiOutlinedInput-root": {
		paddingRight: "8px",
		backgroundColor: theme.palette.base["07"],
		maxHeight: "32px",
		minWidth: "145px",
		borderRadius: "4px",
		border: "1px solid transparent",
		borderColor: $active ? theme.palette.brand["04"] : theme.palette.base["06"],
		"& fieldset": {
			border: "none",
		},
		"&:hover fieldset": {
			border: "none",
		},
		"&.Mui-focused fieldset": {
			border: "none",
		},
	},

	"& .MuiInputBase-input": {
		padding: "8px",
		fontSize: "10px",
		fontFamily: "Poppins",
		fontWeight: 500,
		maxHeight: "32px",
		color: theme.palette.base["02"],

		"&::placeholder": {
			color: theme.palette.base["03"],
			opacity: 1,
		},
	},
}));

export const FilterSearch: React.FC<FilterSearchProps> = ({
	onSearchChange,
	placeholder = "Search",
}) => {
	const [searchText, setSearchText] = useState<string>("");
	const [isSearchFocused, setIsSearchFocused] = useState<boolean>(false);

	const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		const value = event.target.value;
		setSearchText(value);
		onSearchChange(value);
	};

	return (
		<InputRoot
			fullWidth
			placeholder={placeholder}
			value={searchText}
			onChange={handleSearchChange}
			onFocus={() => setIsSearchFocused(true)}
			onBlur={() => setIsSearchFocused(false)}
			$active={isSearchFocused}
			slotProps={{
				input: {
					endAdornment: (
						<InputAdornment
							position="end"
							sx={{
								maxHeight: "32px",
								fontSize: "16px",
								color: (theme) => theme.palette.base["02"],
							}}
						>
							<SearchIcon fontSize="inherit" />
						</InputAdornment>
					),
				},
			}}
		/>
	);
};
