import { styled } from "@mui/material/styles";
import "react-json-view-lite/dist/index.css";
import { JsonView, allExpanded } from "react-json-view-lite";

const JsonViewerContainer = styled("div")(({ theme }) => ({
  fontFamily: "'Poppins', sans-serif",
  fontSize: "12px",
  lineHeight: "1.5",
  backgroundColor: theme.palette.base["01"],
  border: `1px solid ${theme.palette.base["03"]}`,
  borderRadius: "4px",
  padding: "16px",
  overflow: "auto",
  maxHeight: "60dvh",
  minHeight: "200px",

  "& .optimiq-voice-json-container": {
    fontFamily: "'Poppins', sans-serif !important",
    fontSize: "12px !important",
    lineHeight: "1.5 !important",
    color: `${theme.palette.base["07"]} !important`,
    backgroundColor: `${theme.palette.base["01"]} !important`
  },

  // Labels
  "& .optimiq-voice-json-label": {
    color: `${theme.palette.brand["03"]} !important`,
    fontWeight: "500 !important"
  },

  "& .optimiq-voice-json-clickable-label": {
    color: `${theme.palette.brand["03"]} !important`,
    fontWeight: "500 !important",
    cursor: "pointer !important",
    "&:hover": {
      color: `${theme.palette.brand.main} !important`
    }
  },

  "& .optimiq-voice-json-string": {
    color: `${theme.palette.brand.main} !important`
  },

  "& .optimiq-voice-json-number": {
    color: `${theme.palette.brand["04"]} !important`,
    fontWeight: "500 !important"
  },

  "& .optimiq-voice-json-boolean": {
    color: `${theme.palette.brand["02"]} !important`,
    fontWeight: "500 !important"
  },

  "& .optimiq-voice-json-null, & .optimiq-voice-json-undefined": {
    color: `${theme.palette.base["04"]} !important`,
    fontStyle: "italic !important"
  },

  "& .optimiq-voice-json-other": {
    color: `${theme.palette.base["06"]} !important`
  },

  "& .optimiq-voice-json-punctuation": {
    color: `${theme.palette.base["04"]} !important`,
    fontWeight: "400 !important"
  },

  "& .optimiq-voice-json-expand, & .optimiq-voice-json-collapse": {
    color: `${theme.palette.brand.main} !important`,
    cursor: "pointer !important",
    display: "inline-flex !important",
    alignItems: "center !important",
    justifyContent: "center !important",
    width: "12px !important",
    height: "12px !important",
    marginRight: "6px !important",
    fontSize: "10px !important",
    "&:hover": {
      color: `${theme.palette.brand["04"]} !important`
    }
  },

  "& .optimiq-voice-json-collapsed": {
    color: `${theme.palette.base["05"]} !important`,
    fontStyle: "italic !important"
  },

  "& .optimiq-voice-json-children": {
    marginLeft: "16px !important",
    paddingLeft: "4px !important"
  },

  "& .optimiq-voice-json-child": {
    margin: "1px 0 !important",
    padding: "1px 2px !important",
    borderRadius: "2px !important",
    "&:hover": {
      backgroundColor: `${theme.palette.base["02"]} !important`,
      borderRadius: "2px !important"
    }
  },

  "& .optimiq-voice-json-container .rjl-tree-node": {
    position: "relative !important",
    "&::before": {
      content: '""',
      position: "absolute !important",
      left: "-8px !important",
      top: "0 !important",
      bottom: "0 !important",
      width: "1px !important",
      backgroundColor: `${theme.palette.base["03"]} !important`,
      opacity: "0.2 !important"
    },
    "& + .rjl-tree-node": {
      marginTop: "2px !important"
    }
  }
}));

export const JsonViewer = ({
  data = {},
  expanded = allExpanded
}: {
  data: Object | Array<any>;
  expanded?: () => boolean;
}) => {
  const optimiqVoiceDarkStyles = {
    container: "optimiq-voice-json-container",
    basicChildStyle: "optimiq-voice-json-child",
    label: "optimiq-voice-json-label",
    clickableLabel: "optimiq-voice-json-clickable-label",
    nullValue: "optimiq-voice-json-null",
    undefinedValue: "optimiq-voice-json-undefined",
    numberValue: "optimiq-voice-json-number",
    stringValue: "optimiq-voice-json-string",
    booleanValue: "optimiq-voice-json-boolean",
    otherValue: "optimiq-voice-json-other",
    punctuation: "optimiq-voice-json-punctuation",
    expandIcon: "optimiq-voice-json-expand",
    collapseIcon: "optimiq-voice-json-collapse",
    collapsedContent: "optimiq-voice-json-collapsed",
    childFieldsContainer: "optimiq-voice-json-children",
    noQuotesForStringValues: false,
    quotesForFieldNames: true,
    ariaLables: {
      collapseJson: "Collapse JSON",
      expandJson: "Expand JSON"
    },
    stringifyStringValues: false
  };

  return (
    <JsonViewerContainer>
      <JsonView
        data={data}
        shouldExpandNode={expanded}
        style={optimiqVoiceDarkStyles}
      />
    </JsonViewerContainer>
  );
};
