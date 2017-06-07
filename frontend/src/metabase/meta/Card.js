/* @flow */

import { getTemplateTagParameters, getParameterTargetFieldId, parameterToMBQLFilter } from "metabase/meta/Parameter";

import * as Query from "metabase/lib/query/query";
import Q from "metabase/lib/query"; // legacy
import Utils from "metabase/lib/utils";
import * as Urls from "metabase/lib/urls";

import _ from "underscore";
import { assoc, updateIn } from "icepick";

import type { StructuredQuery, NativeQuery, TemplateTag } from "metabase/meta/types/Query";
import type { Card, DatasetQuery, StructuredDatasetQuery, NativeDatasetQuery } from "metabase/meta/types/Card";
import type { Parameter, ParameterMapping, ParameterValues } from "metabase/meta/types/Parameter";
import type { Metadata, TableMetadata } from "metabase/meta/types/Metadata";

declare class Object {
    static values<T>(object: { [key:string]: T }): Array<T>;
}

// TODO Atte Keinänen 6/5/17 Should these be moved to corresponding metabase-lib classes?
// Is there any reason behind keeping them in a central place?

export const STRUCTURED_QUERY_TEMPLATE: StructuredDatasetQuery = {
    type: "query",
    database: null,
    query: {
        source_table: null,
        aggregation: undefined,
        breakout: undefined,
        filter: undefined
    }
};

export const NATIVE_QUERY_TEMPLATE: NativeDatasetQuery = {
    type: "native",
    database: null,
    native: {
        query: "",
        template_tags: {}
    }
};

export const MULTI_QUERY_TEMPLATE: NativeDatasetQuery = {
    type: "multi",
    dataset_queries: []
};

export function isStructured(card: Card): bool {
    return card.dataset_query.type === "query";
}

export function isNative(card: Card): bool {
    return card.dataset_query.type === "native";
}

export function canRun(card: Card): bool {
    if (card.dataset_query.type === "query") {
        const query = getQuery(card);
        return query != null && query.source_table != undefined && Query.hasValidAggregation(query);
    } else if (card.dataset_query.type === "native") {
        const native : NativeQuery = card.dataset_query.native;
        return native && card.dataset_query.database != undefined && native.query !== "";
    } else {
        return false;
    }
}

export function cardIsEquivalent(cardA: Card, cardB: Card): boolean {
    cardA = updateIn(cardA, ["dataset_query", "parameters"], parameters => parameters || []);
    cardB = updateIn(cardB, ["dataset_query", "parameters"], parameters => parameters || []);
    cardA = _.pick(cardA, "dataset_query", "display", "visualization_settings");
    cardB = _.pick(cardB, "dataset_query", "display", "visualization_settings");
    return _.isEqual(cardA, cardB);
}

export function getQuery(card: Card): ?StructuredQuery {
    if (card.dataset_query.type === "query") {
        return card.dataset_query.query;
    } else {
        return null;
    }
}

export function getTableMetadata(card: Card, metadata: Metadata): ?TableMetadata {
    const query = getQuery(card);
    if (query && query.source_table != null) {
        return metadata.tables[query.source_table] || null;
    }
    return null;
}

export function getTemplateTags(card: ?Card): Array<TemplateTag> {
    return card && card.dataset_query && card.dataset_query.type === "native" && card.dataset_query.native.template_tags ?
        Object.values(card.dataset_query.native.template_tags) :
        [];
}

export function getParameters(card: ?Card): Parameter[] {
    if (card && card.parameters) {
        return card.parameters;
    }

    const tags: TemplateTag[] = getTemplateTags(card);
    return getTemplateTagParameters(tags);
}

export function getParametersWithExtras(card: Card, parameterValues?: ParameterValues): Parameter[] {
    return getParameters(card).map(parameter => {
        // if we have a parameter value for this parameter, set "value"
        if (parameterValues && parameter.id in parameterValues) {
            parameter = assoc(parameter, "value", parameterValues[parameter.id]);
        }
        // if we have a field id for this parameter, set "field_id"
        const fieldId = getParameterTargetFieldId(parameter.target, card.dataset_query);
        if (fieldId != null) {
            parameter = assoc(parameter, "field_id", fieldId);
        }
        return parameter;
    })
}

export function applyParameters(
    card: Card,
    parameters: Parameter[],
    parameterValues: ParameterValues = {},
    parameterMappings: ParameterMapping[] = []
): DatasetQuery {
    const datasetQuery = Utils.copy(card.dataset_query);
    // clean the query
    if (datasetQuery.type === "query") {
        datasetQuery.query = Q.cleanQuery(datasetQuery.query);
    }
    datasetQuery.parameters = [];
    for (const parameter of parameters || []) {
        let value = parameterValues[parameter.id];
        if (value == null) {
            continue;
        }

        const mapping = _.findWhere(parameterMappings, {
            // $FlowFixMe original_card_id not included in the flow type of card
            card_id: card.id || card.original_card_id,
            parameter_id: parameter.id
        });
        if (mapping) {
            // mapped target, e.x. on a dashboard
            datasetQuery.parameters.push({
                type: parameter.type,
                target: mapping.target,
                value: value
            });
        } else if (parameter.target) {
            // inline target, e.x. on a card
            datasetQuery.parameters.push({
                type: parameter.type,
                target: parameter.target,
                value: value
            });
        }
    }

    return datasetQuery;
}

/** returns a question URL with parameters added to query string or MBQL filters */
export function questionUrlWithParameters(
    card: Card,
    metadata: Metadata,
    parameters: Parameter[],
    parameterValues: ParameterValues = {},
    parameterMappings: ParameterMapping[] = [],
    cardIsDirty: boolean = true
): DatasetQuery {
    if (!card.dataset_query) {
        return Urls.question(card.id);
    }

    card = Utils.copy(card);

    const cardParameters = getParameters(card);
    const datasetQuery = applyParameters(
        card,
        parameters,
        parameterValues,
        parameterMappings
    );

    // If we have a clean question without parameters applied, don't add the dataset query hash
    if (!cardIsDirty && datasetQuery.parameters && datasetQuery.parameters.length === 0) {
        return Urls.question(card.id);
    }

    const query = {};
    for (const datasetParameter of datasetQuery.parameters || []) {
        const cardParameter = _.find(cardParameters, p =>
            Utils.equals(p.target, datasetParameter.target));
        if (cardParameter) {
            // if the card has a real parameter we can use, use that
            query[cardParameter.slug] = datasetParameter.value;
        } else if (isStructured(card)) {
            // if the card is structured, try converting the parameter to an MBQL filter clause
            const filter = parameterToMBQLFilter(datasetParameter, metadata);
            if (filter) {
                card = updateIn(card, ["dataset_query", "query"], query =>
                    Query.addFilter(query, filter));
            } else {
                console.warn("UNHANDLED PARAMETER", datasetParameter);
            }
        } else {
            console.warn("UNHANDLED PARAMETER", datasetParameter);
        }
    }
    return Urls.question(null, card.dataset_query ? card : undefined, query);
}
