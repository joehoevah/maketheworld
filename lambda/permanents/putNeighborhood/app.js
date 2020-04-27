// Copyright 2020 Tony Lower-Basch. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('/opt/uuid')
const { AppSync, gql } = require('/opt/appsync')
require('cross-fetch/polyfill')

const graphqlClient = new AppSync.AWSAppSyncClient({
    url: process.env.APPSYNC_ENDPOINT_URL,
    region: process.env.AWS_REGION,
    auth: {
      type: 'AWS_IAM',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN
      }
    },
    disableOffline: true
  })

exports.handler = (event) => {

    const { TABLE_PREFIX, AWS_REGION } = process.env;
    const permanentTable = `${TABLE_PREFIX}_permanents`

    const documentClient = new AWS.DynamoDB.DocumentClient({ apiVersion: '2012-08-10', region: AWS_REGION })

    const { PermanentId = '', ParentId = '', Description = '', Name } = event.arguments

    const newNeighborhood = !Boolean(PermanentId)
    const newPermanentId = PermanentId || uuidv4()

    //
    // First check the existing Neighborhood to grab calculated values if they
    // already exist, and see whether this update involves a change of parentage
    // (which will require cascade updates)
    //
    const preCheckLookup = newNeighborhood
        ? Promise.resolve({
            PermanentId: newPermanentId,
            ParentId,
            Name,
            Description
        })
        : documentClient.get({
                TableName: permanentTable,
                Key: {
                    PermanentId: `NEIGHBORHOOD#${newPermanentId}`,
                    DataCategory: 'Details'
                }
            }).promise()
            .then(({ Item = {} }) => (Item))
            .then(({ ParentId: FetchedParentId, Ancestry, ProgenitorId, ...rest }) => ({
                ...rest,
                PermanentId: newPermanentId,
                ParentId,
                Name,
                Description,
                PreviousParentId: FetchedParentId,
                PreviousAncestry: Ancestry,
                PreviousProgenitorId: ProgenitorId
            }))

    //
    // Next, if there is a change of parent then find the new parent (if any) in the
    // database and derive the new Progenitor and Ancestry
    //
    const ancestryLookup = ({
            ParentId,
            PermanentId,
            ...rest
        }) =>
        (ParentId
            ? (ParentId !== rest.PreviousParentId)
                //
                // On change of parent, get the new parent and construct ancestry
                //
                ? documentClient.get({
                        TableName: permanentTable,
                        Key: {
                            PermanentId: `NEIGHBORHOOD#${ParentId}`,
                            DataCategory: 'Details'
                        }
                    }).promise()
                    .then(({ Item = {} }) => (Item))
                    .then(({ Ancestry = '', ProgenitorId = '' }) => ({
                        PermanentId,
                        ParentId,
                        ...rest,
                        Ancestry: `${Ancestry}:${PermanentId}`,
                        ProgenitorId: ProgenitorId || PermanentId
                    }))
                //
                // No change from previous parent, so use previous ancestry
                //
                : Promise.resolve({
                    PermanentId,
                    ParentId,
                    ...rest,
                    Ancestry: rest.PreviousAncestry,
                    ProgenitorId: rest.PreviousProgenitorId
                })
            //
            // No parent means new ancestry and primogenitor are the permanent ID.
            //
            : Promise.resolve({
                PermanentId,
                ParentId,
                ...rest,
                Ancestry: PermanentId,
                ProgenitorId: PermanentId
            }))

    //
    // TODO:  Create a Lambda layer to hold the libraries we need to import for AppSync calls, then
    // attach that layer to this function, and write a translation that creates AppSync call templates
    // from the update calls in cascaseUpdates, and use that to create one large batch AppSync call
    // to the externalPutNeighborhood and externalPutRoom functions, to trigger subscription updates.
    //
    const updateToAppSyncCall = (Items) => (
        Items.length
            ? Promise.resolve(Items)
                .then((Items) => (Items.map(({
                    PermanentId,
                    Name,
                    Ancestry,
                    Description,
                    ParentId,
                }) => (`externalPut${PermanentId.startsWith("ROOM#") ? "Room" : "Neighborhood" } (
                        PermanentId: "${PermanentId.split("#").slice(1).join("#")}",
                        Name: "${Name}",
                        Ancestry: "${Ancestry}",
                        Description: "${Description}",
                        ParentId: "${ParentId}"
                    ) {
                        PermanentId
                        Type
                        Name
                        Ancestry
                        Description
                        ParentId
                    }
                    `))
                ))
                .then((Items) => (Items.reduce((previous, item, index) => (
                        `${previous}\nupdate${index+1}: ${item}`
                    ), '')
                ))
                .then((cascadeUpdate) => {
                    console.log(cascadeUpdate)
                    return cascadeUpdate
                })
                .then((aggregateString) => (gql`mutation CascadeUpdate {
                    ${aggregateString}
                }`))
                .then((cascadeUpdate) => (graphqlClient.mutate({ mutation: cascadeUpdate })))
            : []
    )

    const cascadeUpdates = ({
        Ancestry,
        ProgenitorId,
        PreviousAncestry,
        PreviousProgenitorId,
        ...rest
    }) => ((newNeighborhood || (Ancestry === PreviousAncestry))
        ? { Ancestry, ProgenitorId, ...rest }
        //
        // A parent change means we need to cascade-update all descendants, and then convey
        // that change to AppSync to service subscriptions on the data change.
        //
        : documentClient.query({
                TableName: permanentTable,
                KeyConditionExpression: 'ProgenitorId = :ProgenitorId AND begins_with(Ancestry, :RootAncestry)',
                ExpressionAttributeValues: {
                    ":ProgenitorId": PreviousProgenitorId,
                    ":RootAncestry": PreviousAncestry
                },
                IndexName: "AncestryIndex"
            }).promise()
            .then(({ Items }) => (Items || []))
            .then((result) => {
                console.log(`PRE FILTER (${rest.PermanentId})`)
                console.log(result)
                return result
            })
            .then((Items) => (Items.filter(({ PermanentId }) => (PermanentId.split('#').slice(1).join('#') !== rest.PermanentId))))
            .then((result) => {
                console.log('POST FILTER')
                console.log(result)
                return result
            })
            .then((Items) => (Items.map(({
                    Ancestry: FetchedAncestry,
                    ...rest
                }) => ({
                    ...rest,
                    Ancestry: `${Ancestry}:${FetchedAncestry.slice(PreviousAncestry.length+1)}`,
                    ProgenitorId
                }))
            ))
            //
            // TODO:  Create a manual batching function to break the RequestItems list into
            // chunks of 25 items, and batchWrite them separately in parallel, returning the
            // joint Promise.all.
            //
            .then((Items) => {
                return Items.length
                    ? documentClient.batchWrite({
                            RequestItems: {
                                [permanentTable]: Items.map((Item) => ({
                                    PutRequest: { Item }
                                }))
                            }
                        }).promise().then(() => (Items))
                    : Items
            })
            .then(updateToAppSyncCall)
            .then(() => ({ Ancestry, ProgenitorId, ...rest }))
    )

    const putNeighborhood = ({
        PermanentId,
        ParentId,
        Ancestry,
        ProgenitorId,
        Name,
        Description
    }) => (documentClient.put({
        TableName: permanentTable,
        Item: {
            PermanentId: `NEIGHBORHOOD#${PermanentId}`,
            DataCategory: 'Details',
            ...(ParentId ? { ParentId } : {}),
            Ancestry,
            ProgenitorId,
            Name,
            ...(Description ? { Description } : {})
        },
        ReturnValues: "ALL_OLD"
    }).promise()
        .then((old) => ((old && old.Attributes) || {}))
        .then(({ DataCategory, ...rest }) => ({
            ...rest,
            Type: "NEIGHBORHOOD",
            PermanentId,
            ParentId,
            Ancestry,
            ProgenitorId,
            Name,
            Description
        }))
    )

    return preCheckLookup
        .then((result) => {
            console.log(result)
            return result
        })
        .then(ancestryLookup)
        .then((result) => {
            console.log(result)
            return result
        })
        .then(cascadeUpdates)
        .then(putNeighborhood)
        .then(({ PermanentId, Type, ParentId, Ancestry, Name, Description }) => ({ PermanentId, Type, ParentId, Ancestry, Name, Description }))
        .then((result) => {
            console.log(result)
            return result
        })
        .catch((err) => ({ error: err.stack }))

}